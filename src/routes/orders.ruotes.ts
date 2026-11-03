import { createHash } from "node:crypto";
import { Router } from "express";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { z } from "zod";
import { pool } from "../config/database.js";

const router = Router();

const orderSchema = z
  .object({
    productId: z.number().int().positive(),
    quantity: z.number().int().min(1).max(1000),
  })
  .strict();

interface ProductRow extends RowDataPacket {
  id: number;
  name: string;
  price: string;
  stock: number;
}

interface TotalRow extends RowDataPacket {
  total: string;
}

interface IdempotencyRow extends RowDataPacket {
  request_hash: string;
  status: "processing" | "completed";
  response_status: number | null;
  response_body: unknown;
  order_id: number | null;
}

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return undefined;
}

function getRequestHash(productId: number, quantity: number): string {
  return createHash("sha256")
    .update(JSON.stringify({ productId, quantity }))
    .digest("hex");
}

function sendStoredResponse(
  res: import("express").Response,
  row: IdempotencyRow,
): void {
  if (
    row.status !== "completed" ||
    row.response_status === null ||
    row.response_body === null
  ) {
    res.status(409).json({
      success: false,
      error: {
        code: "IDEMPOTENCY_INCOMPLETE",
        message: "The previous request has no completed response.",
      },
    });
    return;
  }

  let responseBody = row.response_body;
  if (typeof responseBody === "string") {
    try {
      responseBody = JSON.parse(responseBody);
    } catch {
      // Keep as-is if parsing fails
    }
  }

  res.status(row.response_status).json(responseBody);
}

async function findIdempotencyKey(
  key: string,
): Promise<IdempotencyRow | undefined> {
  const [rows] = await pool.execute<IdempotencyRow[]>(
    `SELECT request_hash, status, response_status,
            response_body, order_id
     FROM idempotency_keys
     WHERE \`key\` = ?`,
    [key],
  );

  return rows[0];
}
router.post("/", async (req, res, next) => {
  const parsed = orderSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  const keyHeader = req.get("Idempotency-Key");

  if (
    !keyHeader ||
    keyHeader.length > 128 ||
    !/^[\x21-\x7E]+$/.test(keyHeader)
  ) {
    res.status(400).json({
      success: false,
      error: {
        code: "INVALID_IDEMPOTENCY_KEY",
        message:
          "Provide an Idempotency-Key of 1-128 printable ASCII characters.",
      },
    });
    return;
  }

  const { productId, quantity } = parsed.data;
  const requestHash = getRequestHash(productId, quantity);

  let connection: PoolConnection | undefined;
  let transactionStarted = false;
  let insertingIdempotencyKey = false;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    // Claim this key. A concurrent duplicate waits for the
    // unique constraint to be resolved by the first transaction.
    insertingIdempotencyKey = true;

    await connection.execute(
      `INSERT INTO idempotency_keys
         (\`key\`, request_hash, status)
       VALUES (?, ?, 'processing')`,
      [keyHeader, requestHash],
    );

    insertingIdempotencyKey = false;

    // Lock the product row so its price and stock are consistent
    // throughout this transaction.
    const [products] = await connection.execute<ProductRow[]>(
      `SELECT id, name, price, stock
       FROM products
       WHERE id = ?
       FOR UPDATE`,
      [productId],
    );

    const product = products[0];

    if (!product) {
      await connection.rollback();
      transactionStarted = false;

      res.status(404).json({
        success: false,
        error: {
          code: "PRODUCT_NOT_FOUND",
          message: "Product does not exist.",
        },
      });
      return;
    }

    // Atomic deduction: MySQL only deducts if sufficient stock
    // remains at the moment the UPDATE executes.
    const [deduction] = await connection.execute<ResultSetHeader>(
      `UPDATE products
       SET stock = stock - ?
       WHERE id = ?
         AND stock >= ?`,
      [quantity, productId, quantity],
    );

    if (deduction.affectedRows !== 1) {
      await connection.rollback();
      transactionStarted = false;

      res.status(409).json({
        success: false,
        error: {
          code: "INSUFFICIENT_STOCK",
          message: "Not enough stock to complete this order.",
        },
      });
      return;
    }

    // Calculate the total in MySQL DECIMAL arithmetic rather
    // than multiplying monetary values using JS floating point.
    const [totals] = await connection.execute<TotalRow[]>(
      `SELECT CAST(price * ? AS DECIMAL(14, 2)) AS total
       FROM products
       WHERE id = ?`,
      [quantity, productId],
    );

    const total = totals[0]?.total;

    if (total === undefined) {
      throw new Error("Unable to calculate order total.");
    }

    const [orderResult] = await connection.execute<ResultSetHeader>(
      `INSERT INTO orders
         (product_id, quantity, unit_price, total, status)
       VALUES (?, ?, ?, ?, 'created')`,
      [productId, quantity, product.price, total],
    );

    const orderId = orderResult.insertId;

    const responseBody = {
      success: true,
      data: {
        orderId,
        productId,
        productName: product.name,
        quantity,
        unitPrice: product.price,
        total,
        status: "created",
      },
    };

    // Store the exact successful response for retries.
    await connection.execute(
      `UPDATE idempotency_keys
       SET status = 'completed',
           response_status = 201,
           response_body = ?,
           order_id = ?
       WHERE \`key\` = ?`,
      [JSON.stringify(responseBody), orderId, keyHeader],
    );

    await connection.commit();
    transactionStarted = false;

    res.status(201).json(responseBody);
  } catch (error) {
    if (transactionStarted && connection) {
      try {
        await connection.rollback();
        transactionStarted = false;
      } catch (rollbackError) {
        console.error("Transaction rollback failed:", rollbackError);
      }
    }

    // Only treat duplicate-key errors from the idempotency INSERT
    // as a possible retry. Other errors must remain server errors.
    if (insertingIdempotencyKey && getErrorCode(error) === "ER_DUP_ENTRY") {
      try {
        const existing = await findIdempotencyKey(keyHeader);

        if (!existing) {
          res.status(503).json({
            success: false,
            error: {
              code: "IDEMPOTENCY_RESULT_UNAVAILABLE",
              message: "Retry the request with the same key.",
            },
          });
          return;
        }

        if (existing.request_hash !== requestHash) {
          res.status(409).json({
            success: false,
            error: {
              code: "IDEMPOTENCY_KEY_REUSED",
              message:
                "This key has already been used with a different payload.",
            },
          });
          return;
        }

        sendStoredResponse(res, existing);
        return;
      } catch (lookupError) {
        next(lookupError);
        return;
      }
    }

    console.error("Unhandled API error:", error);

    next(error);
  } finally {
    connection?.release();
  }
});

export default router;
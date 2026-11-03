import { createHash } from "node:crypto";
import { Router } from "express";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { z } from "zod";
import { pool } from "../config/database.js";
import { logger } from "../utils/logger.js";
import { getRequestId } from "../middleware/request-context.js";
import { withTransactionRetry } from "../utils/with-transaction-retry.js";

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

  logger.info(
    { requestId: getRequestId() },
    "Returning stored idempotent response",
  );

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

class RouteError extends Error {
  constructor(
    public statusCode: number,
    public body: unknown,
  ) {
    super("RouteError");
  }
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

  try {
    const result = await withTransactionRetry(async (connection) => {
      // Claim this key. A concurrent duplicate waits for the
      // unique constraint to be resolved by the first transaction.
      await connection.execute(
        `INSERT INTO idempotency_keys
           (\`key\`, request_hash, status)
         VALUES (?, ?, 'processing')`,
        [keyHeader, requestHash],
      );

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
      throw new RouteError(404, {
        success: false,
        error: {
          code: "PRODUCT_NOT_FOUND",
          message: "Product does not exist.",
        },
      });
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
      logger.warn(
        {
          requestId: getRequestId(),
          productId,
          quantity,
        },
        "Order rejected due to insufficient stock",
      );

      throw new RouteError(409, {
        success: false,
        error: {
          code: "INSUFFICIENT_STOCK",
          message: "Not enough stock to complete this order.",
        },
      });
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

    logger.info(
      {
        requestId: getRequestId(),
        orderId,
        productId,
        quantity,
        total,
      },
      "Order created successfully",
    );

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

    return { status: 201, body: responseBody };
    });

    res.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof RouteError) {
      res.status(error.statusCode).json(error.body);
      return;
    }

    if (getErrorCode(error) === "ER_DUP_ENTRY") {
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

    logger.error(
      {
        err: error,
        requestId: getRequestId(),
        productId,
        quantity,
      },
      "Order transaction failed",
    );

    next(error);
  }
});

export default router;
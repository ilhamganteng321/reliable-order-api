import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { RowDataPacket } from "mysql2";
import { app } from "../src/app.js";
import { pool } from "../src/config/database-test.js";

interface StockRow extends RowDataPacket {
  stock: number;
}

interface CountRow extends RowDataPacket {
  total: number;
}

async function getStock(): Promise<number> {
  const [rows] = await pool.query<StockRow[]>(
    "SELECT stock FROM products WHERE id = 1",
  );

  return rows[0]!.stock;
}

async function getOrderCount(): Promise<number> {
  const [rows] = await pool.query<CountRow[]>(
    "SELECT COUNT(*) AS total FROM orders",
  );

  return Number(rows[0]!.total);
}

async function getIdempotencyCount(key: string): Promise<number> {
  const [rows] = await pool.execute<CountRow[]>(
    "SELECT COUNT(*) AS total FROM idempotency_keys WHERE `key` = ?",
    [key],
  );

  return Number(rows[0]!.total);
}

describe("GET /api/products", () => {
  it("returns products from MySQL", async () => {
    const response = await request(app).get("/api/products").expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({
      id: 1,
      name: "Test Keyboard",
      price: "350000.00",
      stock: 5,
    });
  });
});

describe("POST /api/orders", () => {
  it("creates an order and deducts stock exactly once for duplicate requests", async () => {
    const sendOrder = () =>
      request(app)
        .post("/api/orders")
        .set("Idempotency-Key", "duplicate-order-001")
        .send({ productId: 1, quantity: 2 });

    // Deliberately send both requests at the same time.
    const [first, second] = await Promise.all([sendOrder(), sendOrder()]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    expect(first.body.data.orderId).toBe(second.body.data.orderId);
    expect(first.body).toEqual(second.body);

    expect(await getStock()).toBe(3);
    expect(await getOrderCount()).toBe(1);
    expect(await getIdempotencyCount("duplicate-order-001")).toBe(1);
  });

  it("rejects the same key with a different payload", async () => {
    await request(app)
      .post("/api/orders")
      .set("Idempotency-Key", "conflict-order-001")
      .send({ productId: 1, quantity: 1 })
      .expect(201);

    const response = await request(app)
      .post("/api/orders")
      .set("Idempotency-Key", "conflict-order-001")
      .send({ productId: 1, quantity: 2 })
      .expect(409);

    expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await getStock()).toBe(4);
    expect(await getOrderCount()).toBe(1);
  });

  it("rejects an order when stock is insufficient", async () => {
    const response = await request(app)
      .post("/api/orders")
      .set("Idempotency-Key", "insufficient-order-001")
      .send({ productId: 1, quantity: 6 })
      .expect(409);

    expect(response.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(await getStock()).toBe(5);
    expect(await getOrderCount()).toBe(0);

    // This implementation rolls back the idempotency record
    // when stock is insufficient.
    expect(await getIdempotencyCount("insufficient-order-001")).toBe(0);
  });

  it("rolls back stock and idempotency when order insertion fails", async () => {
    await pool.query(`
      CREATE TRIGGER test_fail_order_insert
      BEFORE INSERT ON orders
      FOR EACH ROW
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'forced integration test failure'
    `);

    const response = await request(app)
      .post("/api/orders")
      .set("Idempotency-Key", "rollback-order-001")
      .send({ productId: 1, quantity: 2 })
      .expect(500);

    expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(await getStock()).toBe(5);
    expect(await getOrderCount()).toBe(0);
    expect(await getIdempotencyCount("rollback-order-001")).toBe(0);
  });

  it("prevents overselling with concurrent orders", async () => {
    const totalRequests = 20;

    const responses = await Promise.all(
      Array.from({ length: totalRequests }, (_, index) =>
        request(app)
          .post("/api/orders")
          .set("Idempotency-Key", `concurrent-order-${index}`)
          .send({ productId: 1, quantity: 1 }),
      ),
    );

    const successful = responses.filter((response) => response.status === 201);

    const rejected = responses.filter((response) => response.status === 409);

    expect(successful).toHaveLength(5);
    expect(rejected).toHaveLength(15);

    expect(await getStock()).toBe(0);
    expect(await getOrderCount()).toBe(5);

    // No product stock should ever become negative.
    const [rows] = await pool.query<StockRow[]>(
      "SELECT stock FROM products WHERE id = 1 AND stock < 0",
    );

    expect(rows).toHaveLength(0);
  });
});

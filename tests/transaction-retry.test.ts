import { describe, it, expect } from "vitest";
import { pool } from "../src/config/database.js";
import { withTransactionRetry } from "../src/utils/with-transaction-retry.js";

describe("Transaction Retry", () => {
  it(
    "should retry when MySQL lock wait timeout occurs",
    async () => {
      const blocker = await pool.getConnection();

      let attempts = 0;

      try {
        // Transaction A locks the product.
        await blocker.beginTransaction();

        await blocker.execute(
          "SELECT id FROM products WHERE id = 1 FOR UPDATE",
        );

        // Transaction B repeatedly tries to update the locked product.
        await expect(
          withTransactionRetry(
            async (connection) => {
              attempts++;

              await connection.query(
                "SET SESSION innodb_lock_wait_timeout = 1",
              );

              await connection.execute(
                "UPDATE products SET stock = stock - 1 WHERE id = 1",
              );
            },
            {
              maxRetries: 3,
              baseDelayMs: 50,
              maxDelayMs: 100,
            },
          ),
        ).rejects.toMatchObject({
          code: "ER_LOCK_WAIT_TIMEOUT",
        });

        // Initial attempt + 3 retries.
        expect(attempts).toBe(4);
      } finally {
        await blocker.rollback();
        blocker.release();
      }
    },
    15000,
  );
});
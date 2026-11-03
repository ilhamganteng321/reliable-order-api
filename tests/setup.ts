import "dotenv/config";
import { beforeAll, beforeEach, afterAll } from "vitest";

// Override before application modules are imported by the test files.
const testDatabaseName = process.env.TEST_DB_NAME;

if (testDatabaseName !== "reliable_order_test") {
  throw new Error(
    "TEST_DB_NAME must be exactly reliable_order_test. " +
      "Refusing to run integration tests.",
  );
}

process.env.DB_NAME = testDatabaseName;

let pool: typeof import("../src/config/database-test.js").pool;

beforeAll(async () => {
  const databaseModule = await import("../src/config/database-test.js");
  pool = databaseModule.pool;

  const [rows] = await pool.query("SELECT DATABASE() AS databaseName");

  const result = (rows as Array<{ databaseName: string }>)[0];

  if (result?.databaseName !== process.env.TEST_DB_NAME) {
    throw new Error("Connected to an unexpected test database.");
  }

  // Drop only tables in the explicitly guarded test database.
  await pool.query("DROP TABLE IF EXISTS idempotency_keys");
  await pool.query("DROP TABLE IF EXISTS orders");
  await pool.query("DROP TABLE IF EXISTS products");

  await pool.query(`
    CREATE TABLE products (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(150) NOT NULL,
      price DECIMAL(12, 2) NOT NULL,
      stock INT UNSIGNED NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      CONSTRAINT chk_products_price CHECK (price >= 0)
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE orders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      product_id BIGINT UNSIGNED NOT NULL,
      quantity INT UNSIGNED NOT NULL,
      unit_price DECIMAL(12, 2) NOT NULL,
      total DECIMAL(14, 2) NOT NULL,
      status ENUM('created', 'cancelled') NOT NULL DEFAULT 'created',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_orders_product_id (product_id),
      CONSTRAINT chk_orders_quantity CHECK (quantity > 0),
      CONSTRAINT chk_orders_unit_price CHECK (unit_price >= 0),
      CONSTRAINT chk_orders_total CHECK (total >= 0),
      CONSTRAINT fk_orders_product FOREIGN KEY (product_id)
        REFERENCES products(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE idempotency_keys (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`key\` VARCHAR(128)
        CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      request_hash CHAR(64)
        CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      status ENUM('processing', 'completed') NOT NULL DEFAULT 'processing',
      response_status SMALLINT UNSIGNED NULL,
      response_body JSON NULL,
      order_id BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      CONSTRAINT uq_idempotency_key UNIQUE (\`key\`),
      CONSTRAINT chk_idempotency_response_status CHECK (
        response_status IS NULL OR response_status BETWEEN 100 AND 599
      ),
      CONSTRAINT fk_idempotency_order FOREIGN KEY (order_id)
        REFERENCES orders(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      INDEX idx_idempotency_created_at (created_at)
    ) ENGINE=InnoDB
  `);
});

beforeEach(async () => {
  await pool.query("DROP TRIGGER IF EXISTS test_fail_order_insert");
  await pool.query("DELETE FROM idempotency_keys");
  await pool.query("DELETE FROM orders");
  await pool.query("DELETE FROM products");

  await pool.query(`
    INSERT INTO products (id, name, price, stock)
    VALUES (1, 'Test Keyboard', 350000.00, 5)
  `);
});

afterAll(async () => {
  if (pool) {
    await pool.query("DROP TRIGGER IF EXISTS test_fail_order_insert");
    await pool.end();
  }
});

# Reliable Order API

A backend REST API built with **Node.js, Express, TypeScript, and MySQL** that demonstrates reliable order processing, database transaction management, idempotency, concurrency control, structured logging, and load testing.

The project focuses on solving common backend engineering problems that occur in systems handling concurrent order requests.

## Overview

In an order processing system, multiple clients may attempt to purchase the same product simultaneously. Without proper concurrency control, this can lead to overselling, duplicate orders, or inconsistent database records.

Reliable Order API addresses these problems through:

- **Database Transactions** — Maintain atomicity when creating orders and updating product stock.
- **Idempotency** — Prevent duplicate order creation when clients retry requests.
- **Pessimistic Locking** — Use MySQL `SELECT ... FOR UPDATE` to protect critical stock operations.
- **Atomic Stock Updates** — Ensure stock cannot become negative.
- **Deadlock Handling** — Support controlled retries for retryable transaction failures.
- **Structured Logging** — Generate structured application logs and request IDs.
- **API Documentation** — Provide interactive API documentation using Scalar.
- **Integration Testing** — Validate API behavior against a dedicated test database.
- **Load Testing** — Measure API performance and reliability using k6.

## Tech Stack

| Category | Technology |
|---|---|
| Runtime | Node.js |
| Language | TypeScript |
| Framework | Express.js |
| Database | MySQL 8 |
| Database Driver | mysql2 |
| Validation | Zod |
| Logging | Pino, pino-http |
| API Documentation | OpenAPI 3.1, Scalar |
| Testing | Vitest, Supertest |
| Load Testing | k6 |
| Security | Environment Variables, Input Validation |

## Architecture

```mermaid
flowchart TD
    Client["API Client"]
    API["Express REST API"]
    Middleware["Request Context & Logging"]
    Validation["Zod Validation"]
    OrderService["Order Processing"]
    Transaction["MySQL Transaction"]
    Lock["SELECT FOR UPDATE"]
    Stock["Atomic Stock Update"]
    Idempotency["Idempotency Key"]
    Database[("MySQL Database")]
    Docs["Scalar API Documentation"]
    Tests["Vitest / Supertest"]
    Load["k6 Load Testing"]

    Client --> API
    API --> Middleware
    Middleware --> Validation
    Validation --> OrderService
    OrderService --> Transaction
    Transaction --> Lock
    Lock --> Stock
    Stock --> Idempotency
    Transaction --> Database
    API --> Docs
    Tests --> API
    Load --> API


## Project Structure

```text
reliable-order-api/
├── database/
│   └── schema.sql
│
├── load-tests/
│   └── order-load.js
│
├── src/
│   ├── config/
│   │   ├── database.ts
│   │   ├── env.ts
│   │   └── transaction.ts
│   │
│   ├── docs/
│   │   └── openapi.ts
│   │
│   ├── middleware/
│   │   └── request-context.ts
│   │
│   ├── routes/
│   │   ├── orders.routes.ts
│   │   └── products.routes.ts
│   │
│   ├── utils/
│   │   ├── logger.ts
│   │   └── with-transaction-retry.ts
│   │
│   ├── app.ts
│   └── server.ts
│
├── tests/
│   ├── setup.ts
│   └── ...
│
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

## Getting Started

### 1. Prerequisites

Make sure you have installed:

- Node.js
- npm
- MySQL 8 or later
- Git
- k6 (optional, for load testing)

### 2. Clone Repository

```bash
git clone https://github.com/ilhamganteng321/reliable-order-api.git

cd reliable-order-api
```


### 3. Install Dependencies

```bash
npm install
```

### 4. Configure Environment Variables

Create a `.env` file in the project root.

```env
NODE_ENV=development
PORT=3000

DB_HOST=localhost
DB_PORT=3306
DB_USER=order_api_user
DB_PASSWORD=your_password
DB_NAME=reliable_order
DB_CONNECTION_LIMIT=10

LOG_LEVEL=info
```

Never commit your actual `.env` file or database credentials.

### 5. Create MySQL Database

Open MySQL Workbench or MySQL CLI.

Create the application database and user:

```sql
CREATE DATABASE reliable_order;

CREATE USER 'order_api_user'@'localhost'
IDENTIFIED BY 'your_password';

GRANT SELECT, INSERT, UPDATE, DELETE
ON reliable_order.*
TO 'order_api_user'@'localhost';

FLUSH PRIVILEGES;
```

Apply the database schema:

```bash
mysql -u root -p reliable_order < database/schema.sql
```


### 6. Insert Sample Products

```sql
USE reliable_order;

INSERT INTO products (name, price, stock)
VALUES
    ('Mechanical Keyboard', 350000, 10),
    ('Wireless Mouse', 150000, 5),
    ('USB-C Hub', 275000, 3);
```

### 7. Run the Application

```bash
npm run dev
```

The API will be available at:

```text
http://localhost:3000
```


## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Check application health |
| GET | `/health/db` | Check database connectivity |
| GET | `/api/products` | Retrieve products |
| POST | `/api/orders` | Create a new order |
| GET | `/api-docs` | Interactive API documentation |
| GET | `/openapi.json` | OpenAPI specification |

## Creating an Order

**Endpoint**

```http
POST /api/orders
```

**Headers**

```http
Content-Type: application/json
Idempotency-Key: order-request-001
```

**Request Body**

```json
{
  "productId": 1,
  "quantity": 2
}
```

The `Idempotency-Key` header is required to prevent duplicate order creation when the client retries a request.


### Expected HTTP Status Codes

| Status | Description |
|---|---|
| 201 | Order successfully created |
| 400 | Invalid request body or missing idempotency key |
| 404 | Product not found |
| 409 | Insufficient stock or idempotency conflict |
| 500 | Internal server error |
| 503 | Service temporarily unavailable, if configured |

For the exact response schemas, refer to the interactive API documentation.

## Key Engineering Concepts

### 1. Database Transactions

Order creation and stock reduction must succeed or fail together.

```sql
START TRANSACTION;

SELECT id, price, stock
FROM products
WHERE id = ?
FOR UPDATE;

UPDATE products
SET stock = stock - ?
WHERE id = ?
AND stock >= ?;

INSERT INTO orders (...);

COMMIT;
```

If an operation fails, the transaction is rolled back.

### 2. Idempotency

Each order request must include a unique `Idempotency-Key`.

The API stores:

- Idempotency key
- Request hash
- Processing status
- Response status
- Response body
- Associated order ID

Behavior:

| Scenario | Result |
|---|---|
| Same key + same payload | Return stored response |
| Same key + different payload | Return HTTP 409 |
| New key | Process a new order |

This prevents duplicate orders caused by client retries.


### 3. Concurrency Control

The API uses pessimistic locking through:

```sql
SELECT id, price, stock
FROM products
WHERE id = ?
FOR UPDATE;
```

This prevents multiple transactions from simultaneously modifying the same product stock without synchronization.

Stock is also reduced atomically:

```sql
UPDATE products
SET stock = stock - ?
WHERE id = ?
AND stock >= ?;
```

The application checks `affectedRows` to determine whether the stock update succeeded.

### 4. Deadlock Handling

Retryable MySQL errors such as:

- `ER_LOCK_DEADLOCK`
- `ER_LOCK_WAIT_TIMEOUT`

Can be handled using controlled transaction retries with exponential backoff and jitter.

A new database connection and transaction are used for each retry attempt.

Transactions are not blindly retried after a commit has started because the final commit outcome may be uncertain.


### 5. Structured Logging

Pino generates structured JSON logs containing information such as:

- Request ID
- HTTP method
- Request URL
- Response status
- Response time
- Error details

The `X-Request-ID` response header helps trace individual requests.

## Testing

The project uses Vitest and Supertest for automated API testing.

Run tests:

```bash
npm test
```

The integration test environment uses a separate database:

```text
reliable_order_test
```

This prevents automated tests from modifying development data.

Test scenarios include:

- Product retrieval
- Successful order creation
- Idempotent request replay
- Idempotency key conflict
- Insufficient stock
- Transaction rollback
- Concurrent order requests

Make sure your test environment is configured before running the test suite.


## Load Testing

Load testing is performed using k6.

Start the API using the dedicated load testing database:

```powershell
$env:DB_NAME = "reliable_order_load"
npm run dev
```

Run the load test:

```bash
k6 run load-tests/order-load.js
```

The load test uses:

- 10 virtual users
- 30 seconds duration
- Unique idempotency keys
- HTTP failure threshold below 1%
- 95th percentile response time below 1000ms

### Initial Benchmark

Example result from a local 10-VU test:

| Metric | Result |
|---|---:|
| Virtual Users | 10 |
| Duration | 30 seconds |
| Total Requests | 2,692 |
| Throughput | 89.50 req/s |
| HTTP Failure Rate | 0% |
| Average Response Time | 10.24 ms |
| Median Response Time | 6.89 ms |
| P95 Response Time | 26.83 ms |
| Maximum Response Time | 130.26 ms |

*These are local benchmark results, not production performance guarantees. Results depend on hardware, database configuration, and environment.*


## API Documentation

Interactive API documentation is available through Scalar:

```text
http://localhost:3000/api-docs
```

OpenAPI specification:

```text
http://localhost:3000/openapi.json
```

## Engineering Goals

This project demonstrates practical backend engineering concepts:

- Reliable transaction processing
- Idempotent API design
- Database locking and concurrency control
- Safe transaction retry strategies
- Structured application logging
- API validation and error handling
- Integration testing
- Performance testing

## Future Improvements

- Redis-based distributed rate limiting
- Authentication and authorization
- Transactional Outbox Pattern
- Background job processing
- Message broker integration
- Docker-based development environment
- CI/CD pipeline
- Metrics and observability

## Author

**Ilham Arip**

Backend Developer focused on building reliable APIs, database-driven applications, and scalable backend systems.

- GitHub: https://github.com/ilhamganteng321
- Portfolio: https://persona.ngacir.my.id

---

*Built as a backend engineering portfolio project to explore reliability, consistency, and concurrency in order processing systems.*


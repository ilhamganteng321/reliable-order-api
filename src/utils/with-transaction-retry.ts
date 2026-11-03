import type { PoolConnection } from "mysql2/promise";
import { pool } from "../config/database.js";
import { transactionConfig } from "../config/transaction.js";
import { logger } from "../utils/logger.js";
import { getRequestId } from "../middleware/request-context.js";

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
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

function isRetryableError(error: unknown): boolean {
  const code = getErrorCode(error);

  return (
    code === "ER_LOCK_DEADLOCK" ||
    code === "ER_LOCK_WAIT_TIMEOUT"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTransactionRetry<T>(
  callback: (connection: PoolConnection) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries =
    options.maxRetries ?? transactionConfig.maxRetries;

  const baseDelayMs =
    options.baseDelayMs ?? transactionConfig.baseDelayMs;

  const maxDelayMs =
    options.maxDelayMs ?? transactionConfig.maxDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let connection: PoolConnection | undefined;
    let commitStarted = false;

    try {
      connection = await pool.getConnection();

      await connection.beginTransaction();

      const result = await callback(connection);

      commitStarted = true;
      await connection.commit();

      return result;
    } catch (error) {
      if (connection && !commitStarted) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          logger.error(
            { err: rollbackError, requestId: getRequestId() },
            "Transaction rollback failed",
          );
        }
      }

      const retryable = isRetryableError(error);
      const hasRetriesLeft = attempt < maxRetries;

      if (!retryable || !hasRetriesLeft || commitStarted) {
        throw error;
      }

      const exponentialDelay = Math.min(
        baseDelayMs * 2 ** attempt,
        maxDelayMs,
      );

      const jitter = Math.floor(Math.random() * 50);
      const waitMs = exponentialDelay + jitter;

      logger.warn(
        {
          err: error,
          requestId: getRequestId(),
          attempt: attempt + 1,
          maxRetries,
          waitMs,
        },
        "Retrying transaction after MySQL locking error",
      );

      await delay(waitMs);
    } finally {
      connection?.release();
    }
  }

  throw new Error("Transaction retry limit exceeded");
}
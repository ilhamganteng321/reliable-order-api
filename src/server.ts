import { app } from "./app.js";
import { pool } from "./config/database.js";
import { env } from "./config/env.js";

async function startServer(): Promise<void> {
  try {
    await pool.query("SELECT 1");

    const server = app.listen(env.PORT, () => {
      console.log(`Reliable Order API running at http://localhost:${env.PORT}`);
    });

    const shutdown = (signal: string): void => {
      console.log(`${signal} received. Shutting down...`);

      server.close(() => {
        void pool
          .end()
          .then(() => {
            process.exit(0);
          })
          .catch((error: unknown) => {
            console.error("Failed to close database pool:", error);
            process.exit(1);
          });
      });
    };

    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  } catch (error) {
    console.error("Failed to start Reliable Order API:", error);
    await pool.end().catch(() => undefined);
    process.exit(1);
  }
}

void startServer();

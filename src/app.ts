import express, { type ErrorRequestHandler } from "express";
import { pool } from "./config/database.js";
import productsRouter from "./routes/products.ruotes.js";
import ordersRouter from "./routes/orders.ruotes.js";
import { apiReference } from "@scalar/express-api-reference";
import { openApiDocument } from "./docs/openapi.js";
import { pinoHttp } from "pino-http";
import { logger } from "./utils/logger.js";
import { requestContext, getRequestId } from "./middleware/request-context.js";

export const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

// Generate request ID terlebih dahulu
app.use(requestContext);

// HTTP request logging
app.use(
  pinoHttp({
    logger,

    customProps(req) {
      return {
        requestId: req.requestId,
      };
    },

    customLogLevel(_req, res, err) {
      if (err || res.statusCode >= 500) {
        return "error";
      }

      if (res.statusCode >= 400) {
        return "warn";
      }

      return "info";
    },
  }),
);

// OpenAPI JSON specification
app.get("/openapi.json", (_req, res) => {
  res.status(200).json(openApiDocument);
});

// Scalar API Reference
app.use(
  "/api-docs",
  apiReference({
    content: openApiDocument,
    theme: "default",
    darkMode: true,
    pageTitle: "Reliable Order API Documentation",
  }),
);

app.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Reliable Order API is running",
  });
});

app.get("/health/db", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.status(200).json({
      success: true,
      database: "connected",
    });
  } catch (error) {
    logger.error(
      { err: error, requestId: getRequestId() },
      "Database health check failed",
    );

    res.status(503).json({
      success: false,
      database: "unavailable",
    });
  }
});

app.use("/api/products", productsRouter);
app.use("/api/orders", ordersRouter);

// Handle malformed JSON from express.json().
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "entity.parse.failed"
    ) {
      res.status(400).json({
        success: false,
        error: {
          code: "INVALID_JSON",
          message: "Request body must contain valid JSON.",
        },
      });
      return;
    }

    next(error);
  },
);

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.error(
    {
      err,
      requestId: getRequestId(),
    },
    "Unhandled application error",
  );

  if (res.headersSent) {
    return;
  }

  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal server error",
    },
  });
};

app.use(errorHandler);
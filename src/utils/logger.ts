import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",

  base: {
    service: "reliable-order-api",
    environment: process.env.NODE_ENV ?? "development",
  },

  timestamp: pino.stdTimeFunctions.isoTime,

  redact: {
    paths: [
      "password",
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers.set-cookie",
    ],
    censor: "[REDACTED]",
  },
});
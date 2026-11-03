import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response, NextFunction } from "express";

interface RequestContext {
  requestId: string;
}

const requestStorage = new AsyncLocalStorage<RequestContext>();

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export function requestContext(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = randomUUID();

  req.requestId = requestId;

  res.setHeader("X-Request-ID", requestId);

  requestStorage.run({ requestId }, () => {
    next();
  });
}

export function getRequestId(): string | undefined {
  return requestStorage.getStore()?.requestId;
}
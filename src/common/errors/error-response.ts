import { HttpException } from "@nestjs/common";
import { ZodError } from "zod";

import type { ApiDebugInfo, ApiErrorEnvelope } from "../http/api-response";
import { AppError } from "./app-error";
import { ERROR_STATUS, type ErrorCode } from "./error-codes";

/** What went wrong, before it is put in an envelope. */
export interface ErrorResult {
  status: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
}

const result = (code: ErrorCode, message: string, details?: unknown, status: number = ERROR_STATUS[code]): ErrorResult => ({
  status,
  code,
  message,
  ...(details === undefined ? {} : { details }),
});

function statusOf(exception: unknown): number | null {
  if (exception instanceof HttpException) return exception.getStatus();
  // Fastify's own errors (bad JSON, payload too large, ...) carry `statusCode`.
  const code = (exception as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === "number" ? code : null;
}

/** Pure mapping from anything thrown to an error result. Never leaks internals for 5xx. */
export function toErrorResult(exception: unknown): ErrorResult {
  if (exception instanceof AppError) return result(exception.code, exception.message, exception.details);
  if (exception instanceof ZodError) return result("ValidationFailed", "The request is invalid.", exception.flatten());

  const status = statusOf(exception);
  // A 404 that isn't an AppError comes from the router: the URL doesn't exist.
  if (status === 404) return result("ApiRouteFailed", "Route not found.");
  if (status === 401) return result("Unauthorized", exception instanceof Error ? exception.message : "Authentication required.");
  if (status === 429) return result("RateLimited", "Too many requests. Try again shortly.");
  if (status !== null && status >= 400 && status < 500) {
    // Other 4xx (malformed JSON, payload too large, ...) keep their own HTTP status.
    return result("ValidationFailed", exception instanceof Error ? exception.message : "The request is invalid.", undefined, status);
  }
  return result("InternalError", "Something went wrong. Please try again.");
}

/** Developer-facing detail for the `debug` field. Only ever included outside production. */
export function toDebugInfo(exception: unknown, request: { method: string; url: string }): ApiDebugInfo {
  const err = exception instanceof Error ? exception : null;
  return {
    name: err?.name ?? typeof exception,
    message: err?.message ?? String(exception),
    // The first frames are the useful ones; the rest is framework internals.
    ...(err?.stack ? { stack: err.stack.split("\n").slice(0, 8).join("\n") } : {}),
    method: request.method,
    path: request.url,
    timestamp: new Date().toISOString(),
  };
}

export function toErrorEnvelope(res: ErrorResult, requestId: string, debug?: ApiDebugInfo): ApiErrorEnvelope {
  return {
    code: res.code,
    error: { status: res.status, ...(res.details === undefined ? {} : { details: res.details }) },
    ...(debug ? { debug } : {}),
    message: res.message,
    resourceId: null,
    requestId,
  };
}

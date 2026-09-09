/**
 * The single response envelope.
 *
 * Every endpoint returns exactly this shape, success or failure, so the client
 * never has to guess. The `requestId` is the one thing a user can quote to
 * support that lets an operator find the exact log line — which is why errors
 * carry it and stack traces do not.
 */
import type { Context } from "hono";
import { AppError, SAFE_MESSAGES, type ErrorCode } from "@inkloom/core/errors";

export interface Envelope<T> {
  data: T | null;
  error: { code: string; message: string; details?: Record<string, unknown> } | null;
  requestId: string;
}

export function ok<T>(c: Context, data: T, status = 200): Response {
  const body: Envelope<T> = { data, error: null, requestId: c.get("requestId") };
  return c.json(body, status as 200);
}

export function created<T>(c: Context, data: T): Response {
  return ok(c, data, 201);
}

export function noContent(c: Context): Response {
  return ok(c, { success: true }, 200);
}

/**
 * Render an error.
 *
 * ONLY the safe message and the machine code cross this boundary. An
 * `AppError`'s `context` field — which may hold internals for the log — is
 * never serialised, and a non-AppError is collapsed to a generic 500 so a
 * driver message or constraint name cannot leak.
 */
export function errorResponse(c: Context, error: unknown): Response {
  const requestId = c.get("requestId");

  if (error instanceof AppError) {
    const body: Envelope<never> = {
      data: null,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
      requestId,
    };
    const response = c.json(body, error.status as 400);
    if (error.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
    return response;
  }

  const body: Envelope<never> = {
    data: null,
    error: { code: "INTERNAL_ERROR", message: SAFE_MESSAGES.INTERNAL_ERROR },
    requestId,
  };
  return c.json(body, 500);
}

/** Convenience for throwing inside a handler. */
export function apiError(
  code: ErrorCode,
  options?: ConstructorParameters<typeof AppError>[2],
): AppError {
  return new AppError(code, SAFE_MESSAGES[code], options);
}

export interface PageMeta {
  nextCursor: string | null;
  hasMore: boolean;
}

export function paged<T>(items: T[], nextCursor: string | null) {
  return { items, page: { nextCursor, hasMore: nextCursor !== null } satisfies PageMeta };
}

/**
 * The single response envelope.
 *
 * Every endpoint returns exactly this shape, success or failure, so the client
 * never has to guess. The `requestId` is the one thing a user can quote to
 * support that lets an operator find the exact log line — which is why errors
 * carry it and stack traces do not.
 */
import type { Context } from "hono";
import {
  AppError,
  isDependencyUnavailable,
  SAFE_MESSAGES,
  type ErrorCode,
} from "@inkloom/core/errors";

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
    /*
     * The failure CATEGORY, for the telemetry collector at the Worker edge.
     *
     * A header rather than re-parsing the JSON body, which would mean consuming
     * a stream the caller still needs. The value is the typed code and never
     * the message: codes are a closed set defined in this package, while
     * messages can carry an address, an id or a fragment of a query, and the
     * metrics table they would land in is retained far longer and read far more
     * widely than anything that should hold those.
     *
     * Safe to expose — the same code is already in the body the caller reads.
     */
    response.headers.set("x-error-code", error.code);
    return response;
  }

  /*
   * An unreachable database is not a broken request.
   *
   * 500 says "this request is defective, do not repeat it"; 503 says "come
   * back shortly". A Neon failover or a connection-limit spike is the second
   * thing, and calling it the first told a signing-in user their credentials
   * were at fault, gave proxies and browsers no licence to retry, and left the
   * uptime alert unable to distinguish an outage from a bad deploy.
   *
   * `isDependencyUnavailable` is deliberately narrow — only failures to reach
   * or be admitted by the database — so a constraint violation or a coding
   * error still surfaces as 500 rather than hiding behind a retryable status.
   */
  const unavailable = isDependencyUnavailable(error);
  const code: ErrorCode = unavailable ? "SERVICE_UNAVAILABLE" : "INTERNAL_ERROR";

  const body: Envelope<never> = {
    data: null,
    error: { code, message: SAFE_MESSAGES[code] },
    requestId,
  };
  const response = c.json(body, unavailable ? 503 : 500);
  response.headers.set("x-error-code", code);
  // Short, and a hint rather than a promise: long enough that a client is not
  // hammering a database that is already struggling, short enough that a brief
  // failover is invisible to anyone who waits.
  if (unavailable) response.headers.set("Retry-After", "15");
  return response;
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

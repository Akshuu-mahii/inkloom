/**
 * Zod request validation.
 *
 * Server-side, on every input, always. Client-side validation is a convenience
 * for the user; this is the boundary that actually decides what enters the
 * system. Unknown keys are STRIPPED rather than passed through, so a client
 * cannot smuggle an extra field (`role`, `balance`, `userId`) into an update.
 */
import type { MiddlewareHandler } from "hono";
import type { z } from "zod";
import { apiError, errorResponse } from "../lib/response";
import type { Env } from "../context";

declare module "hono" {
  interface ContextVariableMap {
    validated: unknown;
    validatedQuery: unknown;
  }
}

/** Turn Zod issues into a flat, safe, field-keyed map. */
function toDetails(error: z.ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    // First message per field: enough to fix the input, not a schema dump.
    details[key] ??= issue.message;
  }
  return details;
}

export function validateBody<T extends z.ZodTypeAny>(schema: T): MiddlewareHandler<Env> {
  return async (c, next) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      // Malformed JSON is a client error, never a 500.
      return errorResponse(
        c,
        apiError("VALIDATION_ERROR", { details: { body: "Expected a valid JSON object." } }),
      );
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(c, apiError("VALIDATION_ERROR", { details: toDetails(parsed.error) }));
    }

    c.set("validated", parsed.data);
    return next();
  };
}

export function validateQuery<T extends z.ZodTypeAny>(schema: T): MiddlewareHandler<Env> {
  return async (c, next) => {
    const parsed = schema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!parsed.success) {
      return errorResponse(c, apiError("VALIDATION_ERROR", { details: toDetails(parsed.error) }));
    }
    c.set("validatedQuery", parsed.data);
    return next();
  };
}

/** Typed accessor for the validated body. */
export function body<T>(c: { get: (k: "validated") => unknown }): T {
  return c.get("validated") as T;
}

export function query<T>(c: { get: (k: "validatedQuery") => unknown }): T {
  return c.get("validatedQuery") as T;
}

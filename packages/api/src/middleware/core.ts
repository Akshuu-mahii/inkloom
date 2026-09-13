/**
 * Baseline middleware applied to every API request.
 */
import type { MiddlewareHandler } from "hono";
import { hashIp } from "@inkloom/core";
import { newId } from "@inkloom/db";
import { checkOrigin, isAcceptableContentType, isSafeMethod } from "@inkloom/core/security";
import { errorResponse, apiError } from "../lib/response";
import type { Env, Services } from "../context";

/**
 * Assign a request id and derive the pseudonymous IP hash once.
 *
 * An inbound `x-request-id` is accepted for trace continuity but sanitised —
 * it ends up in logs and in response bodies, so an attacker must not be able to
 * inject arbitrary content through it.
 */
export function requestContext(services: Services): MiddlewareHandler<Env> {
  return async (c, next) => {
    const inbound = c.req.header("x-request-id");
    const requestId = inbound && /^[A-Za-z0-9_-]{1,64}$/.test(inbound) ? inbound : newId("req");

    /*
     * The caller's address, and ONLY from a header the caller cannot write.
     *
     * Cloudflare stamps `CF-Connecting-IP` at the edge, overwriting whatever the
     * client sent, so in production it is trustworthy and nothing else is. The
     * proxy headers below it are not: `X-Forwarded-For` is client-settable by
     * definition, and treating it as authoritative would make every per-IP rate
     * limit free to bypass by rotating one header.
     *
     * Demonstrated rather than assumed: rotating `cf-connecting-ip` across eight
     * signups produced eight separate rate-limit buckets and eight successes
     * against a limit of five. On Cloudflare that request is impossible, because
     * the edge rewrites the header first — but the fallback chain meant a
     * deployment WITHOUT that edge, or any future proxy in front, would silently
     * hand an attacker the same result. Outside production the fallbacks stay,
     * because local development and the test suite have no edge to stamp
     * anything and would otherwise share a single bucket.
     *
     * When nothing trustworthy is present in production the address is simply
     * unknown. `hashIp` returns null for that, per-IP limits stop applying, and
     * the per-ACCOUNT limits carry the load — narrower protection, but no
     * protection is preferable to protection an attacker chooses the key for.
     */
    const trustProxyHeaders = services.config.INKLOOM_ENV !== "production";
    const clientIp =
      c.req.header("cf-connecting-ip") ??
      (trustProxyHeaders
        ? (c.req.header("x-real-ip") ??
          c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
          null)
        : null);

    c.set("requestId", requestId);
    c.set("services", services);
    c.set("clientIp", clientIp);
    c.set("ipHash", await hashIp(clientIp, services.config.IP_HASH_PEPPER));
    c.set("startedAt", Date.now());
    c.set(
      "logger",
      services.logger.child({
        requestId,
        method: c.req.method,
        route: new URL(c.req.url).pathname,
      }),
    );

    c.header("x-request-id", requestId);
    await next();
  };
}

/** One structured line per request. Never logs bodies, headers or cookies. */
export const accessLog: MiddlewareHandler<Env> = async (c, next) => {
  await next();
  const logger = c.get("logger");
  const durationMs = Date.now() - c.get("startedAt");
  const status = c.res.status;

  const fields = {
    status,
    durationMs,
    userId: c.get("principal")?.userId,
  };

  if (status >= 500) logger.error("request_failed", fields);
  else if (status >= 400) logger.warn("request_rejected", fields);
  else logger.info("request", fields);
};

/**
 * Catch everything.
 *
 * A handler that throws must never produce a stack trace, a Postgres message or
 * a constraint name in the response. The full error goes to the log with the
 * request id; the client gets a generic 500 carrying the same id.
 */
export const errorBoundary: MiddlewareHandler<Env> = async (c, next) => {
  try {
    await next();
    // Hono returns 404 with an empty body by default; give it the envelope.
    if (c.res.status === 404 && !c.res.headers.get("content-type")?.includes("json")) {
      return errorResponse(c, apiError("NOT_FOUND"));
    }
  } catch (error) {
    const services = c.get("services");
    const logger = c.get("logger") ?? services?.logger;
    logger?.error("unhandled_error", { error });

    // Reported with a request id and an opaque user id only — never the body,
    // never headers, never a cookie. The payload is redacted on the way out.
    services?.monitoring.captureException(error, {
      requestId: c.get("requestId"),
      userId: c.get("principal")?.userId,
      route: new URL(c.req.url).pathname,
      method: c.req.method,
    });

    return errorResponse(c, error);
  }
  return undefined;
};

/**
 * CSRF and origin enforcement on every state-changing request.
 *
 * Runs before authentication so a forged request is rejected before it can
 * touch a session at all.
 */
export const originGuard: MiddlewareHandler<Env> = async (c, next) => {
  const { config, audit } = c.get("services");

  if (isSafeMethod(c.req.method)) return next();

  const verdict = checkOrigin({
    method: c.req.method,
    origin: c.req.header("origin") ?? null,
    referer: c.req.header("referer") ?? null,
    allowedOrigin: config.origin,
  });

  if (!verdict.ok) {
    await audit.security({
      type: verdict.reason === "missing_origin" ? "csrf_rejected" : "origin_rejected",
      severity: "warning",
      ipHash: c.get("ipHash"),
      requestId: c.get("requestId"),
      metadata: { path: new URL(c.req.url).pathname, reason: verdict.reason },
    });
    return errorResponse(
      c,
      apiError(verdict.reason === "missing_origin" ? "CSRF_REJECTED" : "ORIGIN_REJECTED"),
    );
  }

  // A cross-origin HTML form can only produce urlencoded, multipart or plain
  // text. Requiring JSON closes that vector even if Origin were bypassed.
  const contentType = c.req.header("content-type");
  const hasBody = c.req.header("content-length") !== "0";
  if (hasBody && contentType && !isAcceptableContentType(contentType)) {
    return errorResponse(c, apiError("UNSUPPORTED_MEDIA_TYPE"));
  }

  return next();
};

/**
 * Reject oversized bodies before they are parsed.
 *
 * A 1 MiB ceiling is far above any legitimate Inkloom request (the largest is a
 * support message) and far below anything that could exhaust an isolate.
 */
export const MAX_BODY_BYTES = 1_048_576;

export const bodyLimit: MiddlewareHandler<Env> = async (c, next) => {
  const declared = c.req.header("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    return errorResponse(c, apiError("PAYLOAD_TOO_LARGE"));
  }
  return next();
};

/** Account data must never be cached by a proxy or the browser. */
export const noStore: MiddlewareHandler<Env> = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store, no-cache, must-revalidate, private");
  c.header("Pragma", "no-cache");
};

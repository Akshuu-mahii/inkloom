/**
 * Rate-limit middleware.
 *
 * Every sensitive endpoint is limited on TWO axes — the account or email, and
 * the network — because neither alone is sufficient. IP-only would lock out a
 * whole university behind one NAT; account-only would let a botnet spray
 * across many accounts freely.
 */
import type { MiddlewareHandler } from "hono";
import type { RateLimitBucket } from "@inkloom/core/rate-limit";
import { apiError, errorResponse } from "../lib/response";
import { defer } from "../lib/defer";
import type { Env } from "../context";

export type SubjectResolver = (c: Parameters<MiddlewareHandler<Env>>[0]) => string | null;

/** `user:<id>` — requires an authenticated principal. */
export const bySubjectUser: SubjectResolver = (c) => {
  const p = c.get("principal");
  return p ? `user:${p.userId}` : null;
};

/** `ip:<rotating keyed hash>` — never a raw address. */
export const bySubjectIp: SubjectResolver = (c) => {
  const hash = c.get("ipHash");
  return hash ? `ip:${hash}` : null;
};

/** `email:<normalized>` — for pre-authentication flows keyed on an address. */
export function bySubjectEmail(email: string | null | undefined): SubjectResolver {
  return () => (email ? `email:${email.trim().toLowerCase()}` : null);
}

export interface LimitSpec {
  bucket: RateLimitBucket;
  subject: SubjectResolver;
}

/** Methods that cannot change state, and so are not worth charging. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A per-user ceiling on authenticated writes.
 *
 * The per-endpoint buckets above bound the flows that are worth attacking one
 * at a time — redeeming a code, submitting support, resending a verification.
 * None of them bounds a session in aggregate, so an authenticated client could
 * spray writes across many endpoints and stay under every individual limit
 * while still hammering the database. This is the aggregate limit: 120 writes
 * per user per minute, roughly twenty times what a person clicking through the
 * UI generates, so it is invisible in normal use and only ever catches a script.
 *
 * Deliberately NOT applied to unauthenticated writes. Signup, login and
 * forgot-password have no principal to key on, and each already carries its own
 * per-email and per-network budget; keying those on IP here would double-charge
 * a shared NAT for no gain.
 */
export const writeRateLimit: MiddlewareHandler<Env> = async (c, next) => {
  if (READ_METHODS.has(c.req.method) || !c.get("principal")) return next();
  return rateLimit({ bucket: "api.write.user", subject: bySubjectUser })(c, next);
};

/**
 * Apply one or more limits. All are consumed, then the verdict is taken, so a
 * request that trips the account limit still counts against the network limit
 * (an attacker cannot avoid the network counter by tripping the cheaper one).
 */
export function rateLimit(...specs: LimitSpec[]): MiddlewareHandler<Env> {
  return async (c, next) => {
    const { limiter, audit } = c.get("services");

    const results = await Promise.all(
      specs.map(async (spec) => {
        const subject = spec.subject(c);
        if (!subject) return null;
        return { spec, result: await limiter.consume(spec.bucket, subject) };
      }),
    );

    const blocked = results.find((r) => r && !r.result.allowed);

    if (blocked) {
      await defer(
        c,
        audit.security({
          type: "rate_limit_exceeded",
          severity: "warning",
          userId: c.get("principal")?.userId ?? null,
          ipHash: c.get("ipHash"),
          requestId: c.get("requestId"),
          metadata: { bucket: blocked.spec.bucket, path: new URL(c.req.url).pathname },
        }),
        "rate_limit_exceeded",
      );
      return errorResponse(c, apiError("RATE_LIMITED", { retryAfter: blocked.result.retryAfter }));
    }

    // Surface the tightest remaining budget so a well-behaved client can back off.
    const tightest = results
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => a.result.remaining - b.result.remaining)[0];

    if (tightest) {
      c.header("X-RateLimit-Limit", String(tightest.result.limit));
      c.header("X-RateLimit-Remaining", String(tightest.result.remaining));
      c.header("X-RateLimit-Reset", String(Math.floor(tightest.result.resetAt.getTime() / 1000)));
    }

    return next();
  };
}

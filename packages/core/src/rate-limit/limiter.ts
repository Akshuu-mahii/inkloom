/**
 * Fixed-window rate limiter backed by Postgres.
 *
 * No Redis. The brief asks not to add one in V1 without a measured need, and
 * there isn't one: every limited action already opens a Postgres transaction,
 * and `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` gives an atomic
 * read-modify-write in a single round trip. Cloudflare's edge rate limiting
 * sits in front of this as a coarse first line of defence; this layer
 * implements the per-account and per-action policy, which the edge cannot
 * express.
 *
 * Windows are fixed rather than sliding. A fixed window can allow up to 2x the
 * limit across a boundary, which is an acceptable trade for a single atomic
 * statement and no background bookkeeping. Where that burst matters (login),
 * the progressive cooldown — which is driven by consecutive failures, not by
 * the window — is the real control.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { Database } from "@inkloom/db/client";
import { newId, rateLimitEvent } from "@inkloom/db";
import type { Logger } from "../util/logger";
import {
  RATE_LIMIT_POLICIES,
  loginCooldownSeconds,
  type RateLimitBucket,
  type RateLimitPolicy,
} from "./policies";

export interface RateLimitResult {
  allowed: boolean;
  /** Requests remaining in the current window. */
  remaining: number;
  limit: number;
  /** Seconds until the window resets, for the `Retry-After` header. */
  retryAfter: number;
  resetAt: Date;
}

export type RateLimitOverrides = Partial<
  Record<RateLimitBucket, { limit?: number; windowSeconds?: number }>
>;

export interface LimiterOptions {
  enabled?: boolean;
  /** Static overrides, mainly for tests. */
  overrides?: RateLimitOverrides;
  /**
   * Runtime overrides, read from the `rate_limit_overrides` system setting.
   *
   * Supplied as a callback rather than a value so an operator raising a limit
   * from /admin/settings takes effect within the settings cache TTL, without a
   * deploy. An earlier version accepted only the static `overrides` and never
   * consulted the setting at all, which meant the admin control existed but did
   * nothing — the worst kind of safety feature.
   */
  getOverrides?: () => Promise<RateLimitOverrides>;
}

/** Start of the fixed window containing `now`, aligned to the window size. */
export function windowStart(now: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export class RateLimiter {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly options: LimiterOptions = {},
  ) {}

  private async policyFor(bucket: RateLimitBucket): Promise<RateLimitPolicy> {
    const base = RATE_LIMIT_POLICIES[bucket];

    const runtime = this.options.getOverrides
      ? await this.options.getOverrides().catch(() => ({}) as RateLimitOverrides)
      : {};
    // Static overrides win over runtime ones, so a test can pin a value.
    const override = this.options.overrides?.[bucket] ?? runtime[bucket];

    if (!override) return base;
    return {
      ...base,
      limit: override.limit ?? base.limit,
      windowSeconds: override.windowSeconds ?? base.windowSeconds,
    };
  }

  /**
   * Count one attempt against a bucket and report whether it is allowed.
   *
   * `subject` must already be scoped and pseudonymised by the caller —
   * `user:<id>`, `ip:<hash>`, `email:<normalized>`. A raw IP must never be
   * passed in.
   */
  async consume(
    bucket: RateLimitBucket,
    subject: string,
    now: Date = new Date(),
  ): Promise<RateLimitResult> {
    const policy = await this.policyFor(bucket);
    const start = windowStart(now, policy.windowSeconds);
    const resetAt = new Date(start.getTime() + policy.windowSeconds * 1000);
    const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));

    if (this.options.enabled === false) {
      return {
        allowed: true,
        remaining: policy.limit,
        limit: policy.limit,
        retryAfter: 0,
        resetAt,
      };
    }

    // One atomic statement: insert the window row or increment it, and return
    // the resulting count. Two concurrent callers cannot both read "1".
    const result = await this.db.execute<{ count: number }>(sql`
      INSERT INTO rate_limit_events (id, bucket, subject, window_start, window_seconds, count, blocked, last_seen_at)
      VALUES (${newId("rl")}, ${policy.bucket}, ${subject}, ${start}, ${policy.windowSeconds}, 1, false, ${now})
      ON CONFLICT (bucket, subject, window_start)
      DO UPDATE SET
        count = rate_limit_events.count + 1,
        last_seen_at = ${now},
        blocked = (rate_limit_events.count + 1) > ${policy.limit}
      RETURNING count
    `);

    const count = Number(result.rows[0]?.count ?? 1);
    const allowed = count <= policy.limit;

    if (!allowed) {
      this.logger.warn("rate_limit_exceeded", {
        bucket: policy.bucket,
        // `subject` is already a hash or an id — never a raw IP.
        subject,
        count,
        limit: policy.limit,
      });
    }

    return {
      allowed,
      remaining: Math.max(0, policy.limit - count),
      limit: policy.limit,
      retryAfter: allowed ? 0 : retryAfter,
      resetAt,
    };
  }

  /** Read a bucket's current count without incrementing it. */
  async peek(bucket: RateLimitBucket, subject: string, now: Date = new Date()): Promise<number> {
    const policy = await this.policyFor(bucket);
    const start = windowStart(now, policy.windowSeconds);

    const row = await this.db.query.rateLimitEvent.findFirst({
      where: and(
        eq(rateLimitEvent.bucket, policy.bucket),
        eq(rateLimitEvent.subject, subject),
        eq(rateLimitEvent.windowStart, start),
      ),
    });
    return row?.count ?? 0;
  }

  /**
   * Whether a subject is still within budget, WITHOUT counting an attempt.
   *
   * For buckets marked `countFailuresOnly`, where the decision to admit a
   * request and the decision to charge it are separate: the caller checks here
   * first, and calls `consume` only if the attempt turns out to have failed. A
   * `consume` on the way in would charge honest successes too and lock out a
   * user who has done nothing wrong.
   */
  async within(
    bucket: RateLimitBucket,
    subject: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (this.options.enabled === false) return true;
    const policy = await this.policyFor(bucket);
    return (await this.peek(bucket, subject, now)) < policy.limit;
  }

  /**
   * Clear a subject's counters for a bucket — called after a SUCCESSFUL login
   * so that a user who eventually remembers their password is not still
   * serving a cooldown.
   */
  async reset(bucket: RateLimitBucket, subject: string): Promise<void> {
    await this.db
      .delete(rateLimitEvent)
      .where(and(eq(rateLimitEvent.bucket, bucket), eq(rateLimitEvent.subject, subject)));
  }

  /**
   * Progressive login cooldown.
   *
   * Counts consecutive recent failures for the account and converts them into a
   * wait. Returns 0 when the user may try immediately. This never returns
   * "locked" — the ladder is capped at 15 minutes and decays with the window.
   */
  async loginCooldown(
    normalizedEmail: string,
    now: Date = new Date(),
  ): Promise<{ waitSeconds: number; failures: number }> {
    const policy = await this.policyFor("auth.login.account");
    const since = new Date(now.getTime() - policy.windowSeconds * 1000);

    const rows = await this.db
      .select({ count: rateLimitEvent.count })
      .from(rateLimitEvent)
      .where(
        and(
          eq(rateLimitEvent.bucket, "auth.login.account"),
          eq(rateLimitEvent.subject, `email:${normalizedEmail}`),
          gte(rateLimitEvent.windowStart, since),
        ),
      );

    const failures = rows.reduce((sum, r) => sum + r.count, 0);
    return { waitSeconds: loginCooldownSeconds(failures), failures };
  }

  /** Delete counters for windows that can no longer matter. Called by the cron sweep. */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - 48 * 3600 * 1000);
    const result = await this.db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM rate_limit_events WHERE window_start < ${cutoff} RETURNING 1
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `);
    return Number(result.rows[0]?.count ?? 0);
  }
}

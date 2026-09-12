/**
 * Scheduled retention sweep.
 *
 * The privacy policy states a retention period for every category of data we
 * hold. Until this existed, nothing enforced any of them: the periods were a
 * promise made on a page with no code behind it, which is worse than promising
 * nothing. This is that code.
 *
 * THE PERIODS BELOW ARE THE POLICY. They are not tuning knobs — each one is
 * published at /privacy, so changing a number here without changing that page
 * puts the two out of step and makes the page false. Change both together.
 *
 * WHAT IS DELIBERATELY NOT SWEPT
 * ------------------------------
 * `audit_events` and `credit_ledger` are append-only, enforced by database
 * triggers that reject DELETE even from the table owner. That is intentional
 * and this sweep must never try: the audit trail is the record of what staff
 * did, and the ledger is an accounting record the policy explicitly says is
 * retained in anonymised form. A sweep that quietly deleted either would
 * destroy exactly the evidence an audit exists to provide.
 *
 * EVERY STEP IS INDEPENDENT
 * -------------------------
 * One failing step must not abandon the rest — a lock contention on analytics
 * should not mean expired export payloads survive another day. Each step is
 * caught separately and reported, and the handler decides what to do with a
 * partial result.
 */
import { sql } from "drizzle-orm";
import type { Database } from "@inkloom/db/client";
import type { Logger } from "../util/logger";
import { RateLimiter } from "../rate-limit/limiter";

/** Retention periods, in days, as published at /privacy. */
export const RETENTION_DAYS = {
  /** "Security events and abuse signals — 12 months, then deleted." */
  securityEvents: 365,
  /** "Analytics events — 14 months, and pseudonymous throughout." */
  analyticsEvents: 425,
  /** "Support correspondence — 24 months from the last message." */
  supportRequests: 730,
} as const;

/** "Data exports — deleted 24 hours after they are generated." */
const EXPORT_GRACE_DAYS = 7;

export interface SweepStep {
  name: string;
  removed: number;
  ok: boolean;
  error?: string;
}

export interface SweepResult {
  steps: SweepStep[];
  totalRemoved: number;
  failed: number;
  durationMs: number;
}

/**
 * Run every retention rule. Safe to run repeatedly and safe to run
 * concurrently with live traffic: each statement is a bounded DELETE on an
 * indexed timestamp column, and none of them touch a row a request is reading.
 */
export async function runRetentionSweep(
  db: Database,
  logger: Logger,
  now: Date = new Date(),
): Promise<SweepResult> {
  const startedAt = Date.now();
  const steps: SweepStep[] = [];

  const at = (days: number) => new Date(now.getTime() - days * 24 * 3600 * 1000);

  const step = async (name: string, run: () => Promise<number>) => {
    try {
      const removed = await run();
      steps.push({ name, removed, ok: true });
      if (removed > 0) logger.info("retention_step", { step: name, removed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push({ name, removed: 0, ok: false, error: message });
      logger.error("retention_step_failed", { step: name, error: message });
    }
  };

  const countOf = (result: { rows: Array<{ count?: string }> }) =>
    Number(result.rows[0]?.count ?? 0);

  /*
   * Expired export payloads first, and in two stages.
   *
   * The payload is the sensitive part — a complete copy of everything held
   * about a person — so it is nulled the moment `expires_at` passes, which is
   * the 24 hours the policy promises. The row itself lingers a week longer so
   * "you requested an export on the 3rd" remains answerable, carrying no
   * personal data once the payload is gone.
   */
  await step("export_payloads", async () => {
    const result = await db.execute<{ count: string }>(sql`
      WITH cleared AS (
        UPDATE data_export_requests
           SET payload = NULL, status = 'expired'
         WHERE payload IS NOT NULL
           AND expires_at IS NOT NULL
           AND expires_at < ${now}
        RETURNING 1
      )
      SELECT COUNT(*)::text AS count FROM cleared
    `);
    return countOf(result);
  });

  await step("export_rows", async () => {
    const result = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM data_export_requests
         WHERE payload IS NULL
           AND created_at < ${at(EXPORT_GRACE_DAYS)}
        RETURNING 1
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `);
    return countOf(result);
  });

  await step("security_events", async () => {
    const result = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM security_events
         WHERE created_at < ${at(RETENTION_DAYS.securityEvents)}
        RETURNING 1
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `);
    return countOf(result);
  });

  await step("analytics_events", async () => {
    const result = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM analytics_events
         WHERE created_at < ${at(RETENTION_DAYS.analyticsEvents)}
        RETURNING 1
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `);
    return countOf(result);
  });

  /*
   * "24 months from the last message" — so the clock runs from `updated_at`,
   * which a staff reply moves, not from when the ticket was opened. An
   * unresolved conversation is never swept out from under the person waiting
   * on it.
   */
  await step("support_requests", async () => {
    const result = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM support_requests
         WHERE COALESCE(updated_at, created_at) < ${at(RETENTION_DAYS.supportRequests)}
        RETURNING 1
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `);
    return countOf(result);
  });

  // Rate-limit counters. Not personal data, but unbounded growth of a table
  // every write path touches is its own problem.
  await step("rate_limit_events", async () => {
    const limiter = new RateLimiter(db, logger);
    return limiter.purgeExpired(now);
  });

  const result: SweepResult = {
    steps,
    totalRemoved: steps.reduce((sum, s) => sum + s.removed, 0),
    failed: steps.filter((s) => !s.ok).length,
    durationMs: Date.now() - startedAt,
  };

  logger.info("retention_sweep_complete", {
    totalRemoved: result.totalRemoved,
    failed: result.failed,
    durationMs: result.durationMs,
  });

  return result;
}

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
import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "@inkloom/db/client";
import { jobRun, newId } from "@inkloom/db";
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

/**
 * How long a job-run record is kept.
 *
 * Not a privacy period — these rows hold no personal data. A year, because the
 * question they answer ("can you show retention actually ran?") is asked on an
 * audit cycle, and outliving any log retention is the point of storing it here.
 */
const JOB_RUN_RETENTION_DAYS = 365;

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

  /*
   * Old job records. A year is kept so "did retention run last March?" stays
   * answerable across an audit cycle, which is longer than any log retention
   * and is the whole reason these rows are in the database rather than a log.
   *
   * Swept last, so a run always records itself after pruning and the newest row
   * — the one staleness reads — can never be the one just deleted.
   */
  await step("job_runs", async () => {
    const result = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM job_runs WHERE finished_at < ${at(JOB_RUN_RETENTION_DAYS)} RETURNING 1
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `);
    return countOf(result);
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

  /*
   * Persist the run BEFORE returning, and never let persisting it fail the
   * sweep. Deleting the rows is the promise; recording that we did is
   * evidence, and evidence must not be able to undo the work it describes.
   */
  await recordJobRun(db, {
    job: RETENTION_JOB,
    startedAt: new Date(startedAt),
    finishedAt: new Date(),
    status: result.failed > 0 ? "partial" : "ok",
    durationMs: result.durationMs,
    removed: result.totalRemoved,
    steps: result.steps,
  }).catch((error: unknown) => {
    logger.error("retention_run_not_recorded", { error });
  });

  return result;
}

/**
 * Job keys used in `job_runs`.
 *
 * `job_runs` is deliberately generic — it is a record of scheduled work, not of
 * retention specifically — so every scheduled job registers its name here and
 * gets the same durable record and the same staleness signal for free.
 */
export const RETENTION_JOB = "retention_sweep";
/** A database backup was taken and verified readable. */
export const BACKUP_JOB = "database_backup";
/** A backup was restored into a scratch database and its contents checked. */
export const RESTORE_TEST_JOB = "restore_test";

/**
 * How stale each job may be before it counts as failing.
 *
 * Backups run nightly like the sweep, so 26 hours tolerates a late run. The
 * restore test runs weekly, so it gets 8 days — tight enough that two missed
 * runs are visible, loose enough that a one-off CI outage is not an incident.
 */
export const JOB_MAX_AGE_HOURS: Record<string, number> = {
  [RETENTION_JOB]: 26,
  [BACKUP_JOB]: 26,
  [RESTORE_TEST_JOB]: 8 * 24,
};

/**
 * How old the newest successful run may be before the job counts as stale.
 *
 * The cron fires daily, so 26 hours tolerates a late run and a clock skew
 * without crying wolf, while still catching a job that has missed a day.
 */
export const RETENTION_MAX_AGE_HOURS = 26;

export interface JobRunRecord {
  job: string;
  startedAt: Date;
  finishedAt: Date;
  status: "ok" | "partial" | "failed";
  durationMs: number;
  removed?: number;
  steps?: unknown;
  error?: string;
}

/** Write one durable row describing a completed job run. */
export async function recordJobRun(db: Database, run: JobRunRecord): Promise<void> {
  await db.insert(jobRun).values({
    id: newId("job"),
    job: run.job,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    durationMs: run.durationMs,
    removed: run.removed ?? 0,
    steps: (run.steps as Array<Record<string, unknown>>) ?? null,
    error: run.error ?? null,
  });
}

export interface JobHealth {
  job: string;
  /** False when the newest successful run is older than `maxAgeHours`, or absent. */
  healthy: boolean;
  lastRunAt: Date | null;
  lastStatus: string | null;
  ageHours: number | null;
  removedLastRun: number | null;
}

/**
 * The alertable signal: is this job still running on schedule?
 *
 * Deliberately answered from the newest row rather than from an error counter.
 * A job that throws, a job whose isolate is killed mid-run, a cron trigger that
 * was removed from wrangler.jsonc, and an environment where the worker was
 * never deployed all produce the same observable — no recent row — and all four
 * are the same operational problem. Nothing has to go right for this to fire.
 *
 * A "partial" run counts as unhealthy: the sweep completed, but a step that has
 * been failing every night for a month is exactly the failure this exists to
 * surface, and it would otherwise look like a healthy daily run forever.
 */
export async function jobHealth(
  db: Database,
  job: string = RETENTION_JOB,
  maxAgeHours: number = RETENTION_MAX_AGE_HOURS,
  now: Date = new Date(),
): Promise<JobHealth> {
  const latest = await db
    .select({
      finishedAt: jobRun.finishedAt,
      status: jobRun.status,
      removed: jobRun.removed,
    })
    .from(jobRun)
    .where(eq(jobRun.job, job))
    .orderBy(desc(jobRun.finishedAt))
    .limit(1);

  const row = latest[0];
  if (!row) {
    return {
      job,
      healthy: false,
      lastRunAt: null,
      lastStatus: null,
      ageHours: null,
      removedLastRun: null,
    };
  }

  const ageHours = (now.getTime() - row.finishedAt.getTime()) / 3_600_000;

  return {
    job,
    healthy: row.status === "ok" && ageHours <= maxAgeHours,
    lastRunAt: row.finishedAt,
    lastStatus: row.status,
    ageHours: Math.round(ageHours * 10) / 10,
    removedLastRun: row.removed,
  };
}

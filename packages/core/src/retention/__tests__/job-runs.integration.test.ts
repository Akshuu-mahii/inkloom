/**
 * The retention job must leave evidence, and its silence must be an alarm.
 *
 * Before `job_runs` existed the sweep wrote to Workers Logs, and only when it
 * removed something. A sweep that deleted nothing and a sweep that never ran
 * produced identical evidence: none. That matters more here than for an
 * ordinary cron, because the periods this job enforces are published at
 * /privacy — a promise with no provable enforcement behind it.
 *
 * These tests assert the two properties that make the record worth having: a
 * successful run is queryable afterwards, and the ABSENCE of a recent run is
 * detectable without anything having gone right.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { silentLogger } from "../../util/logger";
import {
  jobHealth,
  recordJobRun,
  RETENTION_JOB,
  RETENTION_MAX_AGE_HOURS,
  runRetentionSweep,
} from "../sweep";
import { connectTestDb, type TestDb } from "../../../../../tests/helpers/db";

let test: TestDb;
const logger = silentLogger;

beforeAll(() => {
  test = connectTestDb();
});

afterAll(async () => {
  await test.close();
});

beforeEach(async () => {
  await test.truncate();
});

const runs = async () => {
  const result = await test.db.execute<{
    job: string;
    status: string;
    removed: number;
    duration_ms: number;
    steps: unknown;
  }>(sql`SELECT job, status, removed, duration_ms, steps FROM job_runs ORDER BY finished_at DESC`);
  return result.rows;
};

// ===========================================================================

describe("the sweep records that it ran", () => {
  it("writes exactly one row for a successful run", async () => {
    const result = await runRetentionSweep(test.db, logger);

    const recorded = await runs();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.job).toBe(RETENTION_JOB);
    expect(recorded[0]!.status).toBe("ok");
    expect(recorded[0]!.removed).toBe(result.totalRemoved);
  });

  it("records a run that removed nothing, which is the case logs could not show", async () => {
    // An empty database: every step succeeds and deletes nothing. This is
    // precisely the run that used to leave no trace at all.
    const result = await runRetentionSweep(test.db, logger);
    expect(result.totalRemoved).toBe(0);

    const recorded = await runs();
    expect(recorded, "a quiet run is still a run").toHaveLength(1);
    expect(recorded[0]!.status).toBe("ok");
  });

  it("keeps per-step detail, so a chronically failing step is visible", async () => {
    await runRetentionSweep(test.db, logger);

    const steps = (await runs())[0]!.steps as Array<{ name: string; ok: boolean }>;
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => typeof s.name === "string")).toBe(true);
  });

  it("accumulates one row per run", async () => {
    await runRetentionSweep(test.db, logger);
    await runRetentionSweep(test.db, logger);
    await runRetentionSweep(test.db, logger);

    expect(await runs()).toHaveLength(3);
  });
});

// ===========================================================================

describe("staleness is the alert", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

  it("reports unhealthy when no run has ever been recorded", async () => {
    const health = await jobHealth(test.db);

    // Covers the cases that otherwise look identical to a quiet job: a cron
    // that was never configured, a trigger dropped from wrangler.jsonc, and an
    // environment where the worker was never deployed.
    expect(health.healthy).toBe(false);
    expect(health.lastRunAt).toBeNull();
    expect(health.lastStatus).toBeNull();
  });

  it("reports healthy right after a successful run", async () => {
    await runRetentionSweep(test.db, logger);

    const health = await jobHealth(test.db);
    expect(health.healthy).toBe(true);
    expect(health.lastStatus).toBe("ok");
    expect(health.ageHours).toBeLessThan(1);
  });

  it("goes unhealthy once the newest run ages past the window", async () => {
    await recordJobRun(test.db, {
      job: RETENTION_JOB,
      startedAt: hoursAgo(RETENTION_MAX_AGE_HOURS + 2),
      finishedAt: hoursAgo(RETENTION_MAX_AGE_HOURS + 2),
      status: "ok",
      durationMs: 120,
    });

    const health = await jobHealth(test.db);
    expect(health.healthy, "a job that missed a day must not read as healthy").toBe(false);
    expect(health.ageHours).toBeGreaterThan(RETENTION_MAX_AGE_HOURS);
  });

  it("tolerates a late run rather than crying wolf", async () => {
    // The cron is daily; a run 25 hours old is late, not broken.
    await recordJobRun(test.db, {
      job: RETENTION_JOB,
      startedAt: hoursAgo(25),
      finishedAt: hoursAgo(25),
      status: "ok",
      durationMs: 120,
    });

    expect((await jobHealth(test.db)).healthy).toBe(true);
  });

  it("treats a partial run as unhealthy", async () => {
    await recordJobRun(test.db, {
      job: RETENTION_JOB,
      startedAt: new Date(),
      finishedAt: new Date(),
      status: "partial",
      durationMs: 120,
    });

    // The sweep deliberately continues past a failing step. A step that has
    // failed every night for a month would otherwise look like a healthy daily
    // run forever, which is exactly the failure this signal exists to catch.
    const health = await jobHealth(test.db);
    expect(health.healthy).toBe(false);
    expect(health.lastStatus).toBe("partial");
  });

  it("treats a recorded hard failure as unhealthy", async () => {
    await recordJobRun(test.db, {
      job: RETENTION_JOB,
      startedAt: new Date(),
      finishedAt: new Date(),
      status: "failed",
      durationMs: 5,
      error: "connection refused",
    });

    expect((await jobHealth(test.db)).healthy).toBe(false);
  });

  it("reads the NEWEST run, not the best one", async () => {
    await recordJobRun(test.db, {
      job: RETENTION_JOB,
      startedAt: hoursAgo(48),
      finishedAt: hoursAgo(48),
      status: "ok",
      durationMs: 100,
    });
    await recordJobRun(test.db, {
      job: RETENTION_JOB,
      startedAt: hoursAgo(1),
      finishedAt: hoursAgo(1),
      status: "failed",
      durationMs: 5,
      error: "boom",
    });

    // A successful run yesterday must not mask a failure today.
    const health = await jobHealth(test.db);
    expect(health.lastStatus).toBe("failed");
    expect(health.healthy).toBe(false);
  });

  it("does not let another job's runs count for this one", async () => {
    await recordJobRun(test.db, {
      job: "some_other_job",
      startedAt: new Date(),
      finishedAt: new Date(),
      status: "ok",
      durationMs: 10,
    });

    expect((await jobHealth(test.db, RETENTION_JOB)).healthy).toBe(false);
  });
});

// ===========================================================================

describe("the record does not grow without bound", () => {
  it("sweeps job rows older than a year, but never the newest", async () => {
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

    await recordJobRun(test.db, {
      job: RETENTION_JOB,
      startedAt: daysAgo(400),
      finishedAt: daysAgo(400),
      status: "ok",
      durationMs: 10,
    });

    await runRetentionSweep(test.db, logger);

    const recorded = await runs();
    // The 400-day-old row is gone; the run that just happened remains, so
    // staleness can still be answered immediately after a sweep.
    expect(recorded).toHaveLength(1);
    expect((await jobHealth(test.db)).healthy).toBe(true);
  });
});

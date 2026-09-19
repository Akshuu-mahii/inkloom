/**
 * The alert is only worth what the check behind it is worth.
 *
 * This decides whether an email gets sent at four in the morning, which makes
 * both directions expensive. A check that misses a stopped backup is the reason
 * you discover the gap on the day you need the archive. A check that fires on a
 * healthy night teaches its recipient to filter the address, and then the real
 * one arrives somewhere nobody looks.
 *
 * So: nothing wrong must produce NOTHING, and each individual fault must be
 * detected on its own, without help from any of the others.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { checkHealth, worstSeverity } from "../index";
import { BACKUP_JOB, recordJobRun, RESTORE_TEST_JOB, RETENTION_JOB } from "../../retention";
import { connectTestDb, createTestUser, type TestDb } from "../../../../../tests/helpers/db";

let test: TestDb;

beforeAll(() => {
  test = connectTestDb();
});

afterAll(async () => {
  await test.close();
});

/** Every scheduled job fresh, so a test can break exactly one thing. */
async function allJobsHealthy() {
  for (const job of [BACKUP_JOB, RETENTION_JOB, RESTORE_TEST_JOB]) {
    await recordJobRun(test.db, {
      job,
      startedAt: new Date(),
      finishedAt: new Date(),
      status: "ok",
      durationMs: 10,
    });
  }
}

beforeEach(async () => {
  await test.truncate();
  await allJobsHealthy();
});

const codes = async () => (await checkHealth(test.db)).problems.map((p) => p.code);

describe("a healthy platform", () => {
  it("reports no problems at all", async () => {
    expect(await codes()).toEqual([]);
  });

  it("still reports the figures it looked at", async () => {
    const report = await checkHealth(test.db);
    expect(Object.keys(report.context)).toEqual(
      expect.arrayContaining([
        BACKUP_JOB,
        RETENTION_JOB,
        RESTORE_TEST_JOB,
        "ledger_drift",
        "errors_24h",
        "critical_security_events_24h",
        "email_24h",
      ]),
    );
  });

  it("has no severity to escalate", async () => {
    expect(worstSeverity([])).toBeNull();
  });
});

describe("each fault is caught on its own", () => {
  it("notices a backup that has stopped, and calls it critical", async () => {
    await test.db.execute(
      sql`UPDATE job_runs SET finished_at = now() - interval '40 hours' WHERE job = ${BACKUP_JOB}`,
    );
    const report = await checkHealth(test.db);
    expect(report.problems.map((p) => p.code)).toEqual([`job.${BACKUP_JOB}`]);
    expect(report.problems[0].severity).toBe("critical");
  });

  // A week-long window: a failure of assurance, not of the thing assured.
  it("notices a stale restore test as a warning, not a critical", async () => {
    await test.db.execute(
      sql`UPDATE job_runs SET finished_at = now() - interval '10 days' WHERE job = ${RESTORE_TEST_JOB}`,
    );
    const report = await checkHealth(test.db);
    expect(report.problems.map((p) => p.code)).toEqual([`job.${RESTORE_TEST_JOB}`]);
    expect(report.problems[0].severity).toBe("warning");
  });

  it("notices a wallet that disagrees with the ledger", async () => {
    const userId = await seedUser();
    await test.db.execute(
      sql`INSERT INTO credit_wallets (id, user_id, balance) VALUES ('wal_health_test', ${userId}, 500)`,
    );
    expect(await codes()).toContain("credits.drift");
  });

  it("notices server errors", async () => {
    await test.db.execute(sql`
      INSERT INTO request_metrics (id, day, hour, route_group, requests, status_5xx)
      VALUES ('rqm_health_test', current_date, 1, '/api', 5, 3)
    `);
    expect(await codes()).toContain("requests.5xx");
  });

  it("notices critical security events", async () => {
    await test.db.execute(sql`
      INSERT INTO security_events (id, type, severity, created_at)
      VALUES ('sev_health_test', 'admin_2fa_failed', 'critical', now())
    `);
    expect(await codes()).toContain("security.critical");
  });

  // Verification mail IS the signup flow, so a provider problem reads to users
  // as "the product is broken" while every dashboard stays green.
  it("notices email that is failing to deliver", async () => {
    await test.db.execute(sql`
      INSERT INTO email_events (id, to_email, template, subject, status, created_at)
      VALUES ('eml_health_test', 'someone@example.test', 'verify_email', 'Confirm', 'bounced', now())
    `);
    expect(await codes()).toContain("email.failed");
  });
});

describe("what it deliberately ignores", () => {
  it("does not flag a 5xx from last week", async () => {
    await test.db.execute(sql`
      INSERT INTO request_metrics (id, day, hour, route_group, requests, status_5xx, updated_at)
      VALUES ('rqm_old', current_date - 7, 1, '/api', 5, 3, now() - interval '7 days')
    `);
    expect(await codes()).not.toContain("requests.5xx");
  });

  it("does not flag delivered email", async () => {
    await test.db.execute(sql`
      INSERT INTO email_events (id, to_email, template, subject, status, created_at)
      VALUES ('eml_ok', 'someone@example.test', 'verify_email', 'Confirm', 'delivered', now())
    `);
    expect(await codes()).not.toContain("email.failed");
  });
});

describe("severity", () => {
  it("lets one critical outrank any number of warnings", () => {
    expect(
      worstSeverity([
        { severity: "warning", code: "a", summary: "", detail: "" },
        { severity: "critical", code: "b", summary: "", detail: "" },
        { severity: "warning", code: "c", summary: "", detail: "" },
      ]),
    ).toBe("critical");
  });
});

async function seedUser(): Promise<string> {
  return (await createTestUser(test.db)).id;
}

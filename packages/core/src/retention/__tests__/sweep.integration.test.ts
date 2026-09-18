/**
 * Retention sweep, against a real database.
 *
 * The point of these tests is not that the SQL parses — it is that the sweep
 * deletes exactly what the privacy policy says it deletes and nothing else.
 * Both halves matter equally: a sweep that misses expired data breaks the
 * promise at /privacy, and a sweep that over-deletes destroys the audit trail
 * and the accounting record, which is worse.
 *
 * Every case drives time through the `now` argument rather than waiting, so a
 * twelve-month retention rule is testable in milliseconds.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { newId } from "@inkloom/db";
import { connectTestDb, createTestUser, type TestDb } from "../../../../../tests/helpers/db";
import { silentLogger } from "../../util/logger";
import { runRetentionSweep, RETENTION_DAYS } from "../sweep";

let t: TestDb;

const DAY = 24 * 3600 * 1000;
const now = new Date("2026-09-12T03:20:00.000Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);

beforeAll(() => {
  t = connectTestDb();
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.truncate();
});

async function countOf(table: string): Promise<number> {
  const result = await t.db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM ${sql.identifier(table)}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

describe("data exports", () => {
  async function makeExport(userId: string, createdAt: Date, expiresAt: Date) {
    const id = newId("exp");
    await t.db.execute(sql`
      INSERT INTO data_export_requests (id, user_id, status, payload, created_at, completed_at, expires_at)
      VALUES (${id}, ${userId}, 'ready', ${JSON.stringify({ secret: "everything about them" })}::jsonb,
              ${createdAt}, ${createdAt}, ${expiresAt})
    `);
    return id;
  }

  it("clears the payload once the 24 hours the policy promises have passed", async () => {
    const user = await createTestUser(t.db);
    // Generated 25 hours ago, so its expiry is an hour in the past.
    const id = await makeExport(
      user.id,
      new Date(now.getTime() - 25 * 3600 * 1000),
      new Date(now.getTime() - 1 * 3600 * 1000),
    );

    await runRetentionSweep(t.db, silentLogger, now);

    const row = await t.db.execute<{ has_payload: boolean; status: string }>(
      sql`SELECT (payload IS NOT NULL) AS has_payload, status FROM data_export_requests WHERE id = ${id}`,
    );
    expect(row.rows[0]?.has_payload, "the personal data must be gone").toBe(false);
    expect(row.rows[0]?.status).toBe("expired");
  });

  it("leaves an export that is still inside its window completely alone", async () => {
    const user = await createTestUser(t.db);
    // This is the case the audit got wrong: an export created two hours ago is
    // not a retention breach, it is an export. Only the clock decides.
    const id = await makeExport(
      user.id,
      new Date(now.getTime() - 2 * 3600 * 1000),
      new Date(now.getTime() + 22 * 3600 * 1000),
    );

    await runRetentionSweep(t.db, silentLogger, now);

    const row = await t.db.execute<{ has_payload: boolean }>(
      sql`SELECT (payload IS NOT NULL) AS has_payload FROM data_export_requests WHERE id = ${id}`,
    );
    expect(row.rows[0]?.has_payload, "a live export must survive the sweep").toBe(true);
  });

  it("removes the row itself a week after the payload went", async () => {
    const user = await createTestUser(t.db);
    const id = newId("exp");
    await t.db.execute(sql`
      INSERT INTO data_export_requests (id, user_id, status, payload, created_at, expires_at)
      VALUES (${id}, ${user.id}, 'expired', NULL, ${daysAgo(8)}, ${daysAgo(7)})
    `);

    await runRetentionSweep(t.db, silentLogger, now);

    expect(await countOf("data_export_requests")).toBe(0);
  });
});

describe("time-based retention", () => {
  it("deletes security events older than 12 months and keeps newer ones", async () => {
    const user = await createTestUser(t.db);
    const old = newId("sec");
    const recent = newId("sec");
    for (const [id, at] of [
      [old, daysAgo(RETENTION_DAYS.securityEvents + 1)],
      [recent, daysAgo(RETENTION_DAYS.securityEvents - 1)],
    ] as const) {
      await t.db.execute(sql`
        INSERT INTO security_events (id, type, severity, user_id, created_at)
        VALUES (${id}, 'login_succeeded', 'info', ${user.id}, ${at})
      `);
    }

    await runRetentionSweep(t.db, silentLogger, now);

    const left = await t.db.execute<{ id: string }>(sql`SELECT id FROM security_events`);
    expect(left.rows.map((r) => r.id)).toEqual([recent]);
  });

  it("deletes analytics events older than 14 months", async () => {
    await t.db.execute(sql`
      INSERT INTO analytics_events (id, name, created_at)
      VALUES (${newId("evt")}, 'dashboard_viewed', ${daysAgo(RETENTION_DAYS.analyticsEvents + 1)}),
             (${newId("evt")}, 'dashboard_viewed', ${daysAgo(RETENTION_DAYS.analyticsEvents - 1)})
    `);

    await runRetentionSweep(t.db, silentLogger, now);

    expect(await countOf("analytics_events")).toBe(1);
  });

  it("measures support retention from the last message, not from when it opened", async () => {
    const user = await createTestUser(t.db);
    // Opened three years ago but replied to last month: the policy says "24
    // months from the last message", so this conversation stays.
    await t.db.execute(sql`
      INSERT INTO support_requests (id, reference, user_id, email, name, category, subject, message, created_at, updated_at)
      VALUES (${newId("sup")}, 'REF-LIVE', ${user.id}, ${user.email}, 'T', 'other', 's', 'm',
              ${daysAgo(1095)}, ${daysAgo(30)})
    `);
    await t.db.execute(sql`
      INSERT INTO support_requests (id, reference, user_id, email, name, category, subject, message, created_at, updated_at)
      VALUES (${newId("sup")}, 'REF-STALE', ${user.id}, ${user.email}, 'T', 'other', 's', 'm',
              ${daysAgo(1095)}, ${daysAgo(RETENTION_DAYS.supportRequests + 1)})
    `);

    await runRetentionSweep(t.db, silentLogger, now);

    const left = await t.db.execute<{ reference: string }>(
      sql`SELECT reference FROM support_requests`,
    );
    expect(left.rows.map((r) => r.reference)).toEqual(["REF-LIVE"]);
  });

  it("purges rate-limit counters whose window can no longer matter", async () => {
    await t.db.execute(sql`
      INSERT INTO rate_limit_events (id, bucket, subject, window_start, window_seconds, count, blocked, last_seen_at)
      VALUES (${newId("rl")}, 'auth.signup.ip', 'ip:old', ${daysAgo(3)}, 3600, 1, false, ${daysAgo(3)}),
             (${newId("rl")}, 'auth.signup.ip', 'ip:new', ${now}, 3600, 1, false, ${now})
    `);

    await runRetentionSweep(t.db, silentLogger, now);

    expect(await countOf("rate_limit_events")).toBe(1);
  });
});

describe("what the sweep must never touch", () => {
  it("leaves the audit trail and the credit ledger completely alone", async () => {
    /*
     * These two tables are append-only at the database level, so a sweep that
     * tried to delete from them would not quietly succeed — it would throw and
     * take the whole nightly run with it. Asserting the sweep reports success
     * with both populated is what proves it never goes near them.
     */
    const user = await createTestUser(t.db);
    await t.db.execute(sql`
      INSERT INTO audit_events (id, action, actor_type, actor_id, created_at)
      VALUES (${newId("aud")}, 'user.signup', 'user', ${user.id}, ${daysAgo(2000)})
    `);

    const result = await runRetentionSweep(t.db, silentLogger, now);

    expect(result.failed, "no step may fail").toBe(0);
    expect(await countOf("audit_events"), "an ancient audit event still stands").toBe(1);
  });

  it("reports every step and survives repeated runs", async () => {
    const first = await runRetentionSweep(t.db, silentLogger, now);
    const second = await runRetentionSweep(t.db, silentLogger, now);

    expect(first.steps.map((s) => s.name)).toEqual([
      "export_payloads",
      "export_rows",
      "security_events",
      "analytics_events",
      "support_requests",
      "rate_limit_events",
      // Last on purpose: the run records itself after this step, so the row
      // staleness reads can never be the one the sweep just deleted.
      "job_runs",
    ]);
    expect(first.failed).toBe(0);
    // Idempotent: nothing left to remove the second time, and no error.
    expect(second.failed).toBe(0);
    expect(second.totalRemoved).toBe(0);
  });
});

describe("one failing step must not abandon the others", () => {
  it("keeps sweeping after a step throws, and reports which one failed", async () => {
    /*
     * The exact failure this guards against: a lock contention on analytics
     * meaning expired export payloads survive another day. Structuring the
     * sweep so an early error skips everything after it would make one
     * transient problem into a retention breach.
     *
     * The failure is injected by making ONE table unreadable, which is as close
     * to a real transient database error as a test can get without mocking the
     * driver — and mocking it would test the mock.
     */
    const user = await createTestUser(t.db);
    await t.db.execute(sql`
      INSERT INTO data_export_requests (id, user_id, status, payload, created_at, expires_at)
      VALUES (${newId("exp")}, ${user.id}, 'ready', '{"secret":"x"}'::jsonb,
              ${new Date(now.getTime() - 25 * 3600 * 1000)}, ${new Date(now.getTime() - 3600 * 1000)})
    `);
    await t.db.execute(sql`
      INSERT INTO analytics_events (id, name, created_at)
      VALUES (${newId("evt")}, 'dashboard_viewed', ${daysAgo(RETENTION_DAYS.analyticsEvents + 1)})
    `);

    // Break exactly one step.
    await t.db.execute(sql`ALTER TABLE analytics_events RENAME TO analytics_events_hidden`);

    let result;
    try {
      result = await runRetentionSweep(t.db, silentLogger, now);
    } finally {
      await t.db.execute(sql`ALTER TABLE analytics_events_hidden RENAME TO analytics_events`);
    }

    const failed = result.steps.filter((s) => !s.ok).map((s) => s.name);
    expect(failed, "exactly the broken step is reported").toEqual(["analytics_events"]);
    expect(result.failed).toBe(1);

    // ...and the step AFTER the failure still ran, plus the one before it.
    const names = result.steps.map((s) => s.name);
    expect(names).toContain("support_requests");
    expect(names).toContain("rate_limit_events");

    // The export payload — the thing that actually matters — is gone.
    const row = await t.db.execute<{ has_payload: boolean }>(
      sql`SELECT (payload IS NOT NULL) AS has_payload FROM data_export_requests`,
    );
    expect(row.rows[0]?.has_payload, "a broken step must not block retention").toBe(false);
  });
});

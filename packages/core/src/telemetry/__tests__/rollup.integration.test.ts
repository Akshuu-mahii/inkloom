/**
 * Daily roll-up.
 *
 * The assertions worth having are about WHERE each number comes from, because
 * that is the part that is easy to get plausibly wrong: a DAU read from the
 * wrong table still produces a believable figure, and nobody notices until it
 * is used to make a decision.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { newId } from "@inkloom/db";
import { connectTestDb, createTestUser, type TestDb } from "../../../../../tests/helpers/db";
import { silentLogger } from "../../util/logger";
import { captureSelfMeasuredUsage, previousDay, rollUpDay } from "../rollup";

let t: TestDb;
const DAY = "2026-09-12";

beforeAll(() => {
  t = connectTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.truncate();
  await t.db.execute(sql`TRUNCATE TABLE daily_metrics, provider_metrics`);
});

async function row() {
  const result = await t.db.execute<Record<string, number | string | null>>(
    sql`SELECT * FROM daily_metrics WHERE day = ${DAY}::date`,
  );
  return result.rows[0];
}

/** A session whose last activity lands on a given instant. */
async function sessionFor(userId: string, lastActiveAt: string) {
  await t.db.execute(sql`
    INSERT INTO sessions (id, token, user_id, expires_at, last_active_at, created_at, updated_at)
    VALUES (${newId("ses")}, ${newId("ses")}, ${userId},
            now() + interval '7 days', ${lastActiveAt}::timestamptz,
            ${lastActiveAt}::timestamptz, ${lastActiveAt}::timestamptz)
  `);
}

describe("active users", () => {
  it("counts from sessions, so declining analytics does not hide a user", async () => {
    /*
     * The decision this pins down. Analytics only fires for people who accepted
     * the cookie notice, so a DAU read from it moves whenever consent rates
     * move — which looks exactly like a product change and is not one.
     */
    const consenting = await createTestUser(t.db, { email: "yes@example.test" });
    const declining = await createTestUser(t.db, { email: "no@example.test" });

    await sessionFor(consenting.id, `${DAY}T10:00:00Z`);
    await sessionFor(declining.id, `${DAY}T11:00:00Z`);

    // Only one of them generated an analytics event.
    await t.db.execute(sql`
      INSERT INTO analytics_events (id, name, user_id, created_at)
      VALUES (${newId("evt")}, 'dashboard_viewed', ${consenting.id}, ${`${DAY}T10:01:00Z`}::timestamptz)
    `);

    await rollUpDay(t.db, silentLogger, DAY);

    expect(await row().then((r) => r?.dau), "both users were active").toBe(2);
  });

  it("uses trailing windows that end on the day being summarised", async () => {
    const user = await createTestUser(t.db);
    // Active three days before the day in question: inside WAU, outside DAU.
    await sessionFor(user.id, "2026-09-09T12:00:00Z");

    await rollUpDay(t.db, silentLogger, DAY);
    const r = await row();

    expect(r?.dau, "not active on the day itself").toBe(0);
    expect(r?.wau, "but inside the trailing week").toBe(1);
    expect(r?.mau).toBe(1);
  });
});

describe("day boundaries", () => {
  it("counts a signup on its own day and not the next", async () => {
    await createTestUser(t.db, { email: "onday@example.test" });
    await t.db.execute(
      sql`UPDATE users SET created_at = ${`${DAY}T23:59:59Z`}::timestamptz WHERE email = 'onday@example.test'`,
    );
    await createTestUser(t.db, { email: "nextday@example.test" });
    await t.db.execute(
      sql`UPDATE users SET created_at = ${"2026-09-13T00:00:01Z"}::timestamptz WHERE email = 'nextday@example.test'`,
    );

    await rollUpDay(t.db, silentLogger, DAY);
    const r = await row();

    expect(r?.signups, "one signup on the day, one after midnight").toBe(1);
    // The running total is as at the END of that day, so it excludes the later one.
    expect(r?.users_total).toBe(1);
  });
});

describe("credits", () => {
  it("reports issued and spent as separate positive figures", async () => {
    const user = await createTestUser(t.db);
    /*
     * The wallet is created by Better Auth's user-create hook, which this
     * helper bypasses — it writes the row directly. So it is made explicitly
     * here rather than assumed.
     */
    const walletId = newId("wal");
    await t.db.execute(sql`
      INSERT INTO credit_wallets (id, user_id, balance, version)
      VALUES (${walletId}, ${user.id}, 1500, 0)
    `);

    /*
     * Real ledger types, not invented ones. The table enforces that the sign
     * matches the type and that reference, idempotency key and reason are all
     * present — the accounting integrity this whole system is built around. A
     * fixture that could bypass those would be testing a table that does not
     * exist in production.
     */
    for (const [type, amount, balanceAfter] of [
      ["ADMIN_GRANT", 2000, 2000],
      ["ADMIN_DEDUCTION", -500, 1500],
    ] as const) {
      await t.db.execute(sql`
        INSERT INTO credit_ledger (
          id, user_id, wallet_id, amount, balance_after, type,
          reference_type, idempotency_key, actor_type, reason, metadata, created_at
        )
        VALUES (
          ${newId("led")}, ${user.id}, ${walletId}, ${amount}, ${balanceAfter}, ${type},
          'admin_adjustment', ${newId("idem")}, 'system', 'rollup test', '{}'::jsonb,
          ${`${DAY}T12:00:00Z`}::timestamptz
        )
      `);
    }

    await rollUpDay(t.db, silentLogger, DAY);
    const r = await row();

    expect(r?.credits_issued).toBe(2000);
    // Spent is stored negative and reported positive, so a dashboard never has
    // to know the sign convention to render it.
    expect(r?.credits_spent).toBe(500);
  });
});

describe("re-running", () => {
  it("replaces the day rather than adding to it", async () => {
    await createTestUser(t.db, { email: "a@example.test" });
    await t.db.execute(
      sql`UPDATE users SET created_at = ${`${DAY}T09:00:00Z`}::timestamptz WHERE email = 'a@example.test'`,
    );

    await rollUpDay(t.db, silentLogger, DAY);
    await rollUpDay(t.db, silentLogger, DAY);

    const count = await t.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM daily_metrics WHERE day = ${DAY}::date`,
    );
    expect(Number(count.rows[0]?.count), "one row per day, always").toBe(1);
    expect(await row().then((r) => r?.signups), "counts must not double").toBe(1);
  });
});

describe("self-measured usage", () => {
  it("records only what the application can see itself", async () => {
    const written = await captureSelfMeasuredUsage(t.db, silentLogger, DAY);
    expect(written).toBe(3);

    const rows = await t.db.execute<{ provider: string; metric: string }>(
      sql`SELECT provider, metric FROM provider_metrics ORDER BY provider, metric`,
    );
    expect(rows.rows.map((r) => `${r.provider}.${r.metric}`)).toEqual([
      "database.connections",
      "database.storage_bytes",
      "resend.emails_sent",
    ]);
  });

  it("is idempotent, so a re-run updates rather than duplicates", async () => {
    await captureSelfMeasuredUsage(t.db, silentLogger, DAY);
    await captureSelfMeasuredUsage(t.db, silentLogger, DAY);
    const count = await t.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM provider_metrics`,
    );
    expect(Number(count.rows[0]?.count)).toBe(3);
  });
});

describe("which day is summarised", () => {
  it("defaults to the day that just ended, not the one in progress", () => {
    // A 03:20 cron summarising "today" would report three hours of a day.
    expect(previousDay(new Date("2026-09-13T03:20:00Z"))).toBe("2026-09-12");
  });
});

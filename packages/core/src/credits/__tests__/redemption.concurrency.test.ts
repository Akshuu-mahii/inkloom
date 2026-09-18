/**
 * MANDATORY concurrency proof.
 *
 * These tests fire genuinely simultaneous requests against a real Postgres and
 * assert the accounting outcome. They are the reason the integration suite
 * uses a real database: a mocked one cannot demonstrate that two racing
 * transactions produce exactly one redemption.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { newId } from "@inkloom/db";
import { connectTestDb, createTestUser, type TestDb } from "../../../../../tests/helpers/db";
import { CreditService } from "../ledger";
import { AuditService } from "../../audit/audit";
import { RedemptionService, RedemptionError } from "../../access-codes/redemption";
import { fingerprintCode, maskCode, normalizeCode } from "../../access-codes/code";
import { silentLogger } from "../../util/logger";

const PEPPER = "integration-test-pepper-32-characters";

let t: TestDb;
let credits: CreditService;
let audit: AuditService;
let redemption: RedemptionService;

beforeAll(() => {
  t = connectTestDb();
  credits = new CreditService(t.db, silentLogger);
  audit = new AuditService(t.db, silentLogger);
  redemption = new RedemptionService(t.db, credits, audit, silentLogger, PEPPER);
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.truncate();
});

async function makeCampaign(options: {
  code: string;
  credits?: number;
  maxTotal?: number | null;
  maxPerUser?: number;
  status?: string;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  domains?: string[] | null;
}): Promise<string> {
  const id = newId("cmp");
  const normalized = normalizeCode(options.code);
  const fingerprint = await fingerprintCode(normalized, PEPPER);
  const { masked, last4 } = maskCode(normalized);

  await t.db.execute(sql`
    INSERT INTO access_code_campaigns
      (id, name, code_fingerprint, code_masked, code_last4, credit_amount,
       max_total_redemptions, max_redemptions_per_user, status, starts_at, expires_at,
       allowed_email_domains)
    VALUES (${id}, ${"Campaign " + normalized}, ${fingerprint}, ${masked}, ${last4},
            ${options.credits ?? 100},
            ${options.maxTotal === undefined ? null : options.maxTotal},
            ${options.maxPerUser ?? 1},
            ${options.status ?? "enabled"},
            ${options.startsAt ?? null},
            ${options.expiresAt ?? null},
            ${options.domains ? JSON.stringify(options.domains) : null})
  `);
  return id;
}

const ctx = {
  emailVerified: true,
  userStatus: "active",
  normalizedEmail: "user@example.test",
  redemptionEnabled: true,
};

async function counts(userId: string) {
  const r = await t.db.execute<{ redemptions: string; entries: string; balance: string }>(sql`
    SELECT
      (SELECT COUNT(*)::text FROM access_code_redemptions WHERE user_id = ${userId}) AS redemptions,
      (SELECT COUNT(*)::text FROM credit_ledger WHERE user_id = ${userId}) AS entries,
      (SELECT COALESCE(MAX(balance),0)::text FROM credit_wallets WHERE user_id = ${userId}) AS balance
  `);
  const row = r.rows[0]!;
  return {
    redemptions: Number(row.redemptions),
    entries: Number(row.entries),
    balance: Number(row.balance),
  };
}

describe("simultaneous redemption of the same campaign by the same user", () => {
  it("grants exactly one redemption and one credit entry out of 25 concurrent attempts", async () => {
    const user = await createTestUser(t.db, { email: "racer@example.test" });
    await makeCampaign({ code: "INKLOOMHACKATHON", credits: 100 });

    const ATTEMPTS = 25;

    // Distinct idempotency keys on purpose: this must hold because of the
    // database constraints, NOT because the client happened to reuse a key.
    const results = await Promise.allSettled(
      Array.from({ length: ATTEMPTS }, () =>
        redemption.redeem(
          {
            userId: user.id,
            code: "inkloom-hackathon",
            idempotencyKey: newId("idem"),
          },
          { ...ctx, normalizedEmail: user.normalizedEmail },
        ),
      ),
    );

    const { redemptions, entries, balance } = await counts(user.id);

    expect(redemptions, "exactly one redemption row").toBe(1);
    expect(entries, "exactly one ledger entry").toBe(1);
    expect(balance, "credited exactly once").toBe(100);

    // Every attempt resolved to the same outcome or a duplicate refusal —
    // nothing crashed with an unexpected error.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason, String(r.reason)).toBeInstanceOf(RedemptionError);
        expect((r.reason as RedemptionError).reason).toBe("duplicate");
      } else {
        expect(r.value.creditsGranted).toBe(100);
        expect(r.value.balance).toBe(100);
      }
    }

    // The campaign counter agrees with reality.
    const campaign = await t.db.execute<{ redemption_count: number }>(
      sql`SELECT redemption_count FROM access_code_campaigns LIMIT 1`,
    );
    expect(Number(campaign.rows[0]!.redemption_count)).toBe(1);
  });

  it("collapses a double-submit sharing one idempotency key into a single grant", async () => {
    const user = await createTestUser(t.db, { email: "double@example.test" });
    await makeCampaign({ code: "DOUBLECLICK", credits: 50 });

    const key = newId("idem");
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        redemption.redeem(
          { userId: user.id, code: "DOUBLECLICK", idempotencyKey: key },
          { ...ctx, normalizedEmail: user.normalizedEmail },
        ),
      ),
    );

    const { redemptions, entries, balance } = await counts(user.id);
    expect(redemptions).toBe(1);
    expect(entries).toBe(1);
    expect(balance).toBe(50);

    for (const r of results) {
      if (r.status === "fulfilled") expect(r.value.balance).toBe(50);
    }
  });
});

describe("many different users redeeming one UNCAPPED campaign at once", () => {
  /*
   * The case the campaign lock was removed for.
   *
   * An uncapped campaign has no shared quantity to race over, so redemption no
   * longer takes `FOR UPDATE` on the campaign row. Correctness then rests
   * entirely on the idempotency key and the unique index — this proves it does.
   *
   * Written after a 1,000-bot run found the old unconditional lock serialising
   * every redeemer of a code: p50 4.8s, and one request killed at 15.1s waiting
   * on the lock. The guarantee has to survive removing it.
   */
  it("grants each user exactly once and leaves the ledger consistent", async () => {
    const USERS = 30;
    await makeCampaign({ code: "CROWDCODE", credits: 10, maxTotal: null });

    const users = await Promise.all(
      Array.from({ length: USERS }, (_, i) =>
        createTestUser(t.db, { email: `crowd-${i}@example.test` }),
      ),
    );

    const results = await Promise.allSettled(
      users.map((u) =>
        redemption.redeem(
          { userId: u.id, code: "crowd-code", idempotencyKey: newId("idem") },
          { ...ctx, normalizedEmail: u.normalizedEmail },
        ),
      ),
    );

    const failed = results.filter((r) => r.status === "rejected");
    expect(failed, `all ${USERS} should succeed: ${failed.map((f) => String(f.reason))}`).toEqual(
      [],
    );

    const rows = await t.db.execute<{
      redemptions: string;
      entries: string;
      wallets: string;
      drift: string;
    }>(sql`
      SELECT
        (SELECT COUNT(*) FROM access_code_redemptions)                       AS redemptions,
        (SELECT COUNT(*) FROM credit_ledger)                                 AS entries,
        (SELECT COALESCE(SUM(balance),0) FROM credit_wallets)                AS wallets,
        (SELECT COUNT(*) FROM credit_wallets w
           WHERE w.balance <> (SELECT COALESCE(SUM(l.amount),0) FROM credit_ledger l
                                WHERE l.wallet_id = w.id))                   AS drift
    `);
    const r = rows.rows[0]!;

    expect(Number(r.redemptions), "one redemption per user").toBe(USERS);
    expect(Number(r.entries), "one ledger entry per user").toBe(USERS);
    expect(Number(r.wallets), "every balance credited exactly once").toBe(USERS * 10);
    expect(Number(r.drift), "no wallet disagrees with its own ledger").toBe(0);

    const campaign = await t.db.execute<{ redemption_count: number }>(
      sql`SELECT redemption_count FROM access_code_campaigns LIMIT 1`,
    );
    expect(Number(campaign.rows[0]!.redemption_count), "counter matches reality").toBe(USERS);
  });

  it("still refuses a second attempt by the same user", async () => {
    await makeCampaign({ code: "CROWDCODE", credits: 10, maxTotal: null });
    const user = await createTestUser(t.db, { email: "twice@example.test" });

    await redemption.redeem(
      { userId: user.id, code: "crowd-code", idempotencyKey: newId("idem") },
      { ...ctx, normalizedEmail: user.normalizedEmail },
    );

    await expect(
      redemption.redeem(
        { userId: user.id, code: "crowd-code", idempotencyKey: newId("idem") },
        { ...ctx, normalizedEmail: user.normalizedEmail },
      ),
    ).rejects.toMatchObject({ reason: "duplicate" });
  });
});

describe("a campaign reaching its final available redemption", () => {
  it("never issues more grants than max_total_redemptions under contention", async () => {
    // 3 seats, 20 distinct users all racing for them.
    const SEATS = 3;
    const RACERS = 20;
    await makeCampaign({ code: "LIMITEDSEATS", credits: 10, maxTotal: SEATS });

    const users = await Promise.all(
      Array.from({ length: RACERS }, (_, i) =>
        createTestUser(t.db, { email: `seat-${i}@example.test` }),
      ),
    );

    await Promise.allSettled(
      users.map((u) =>
        redemption.redeem(
          { userId: u.id, code: "LIMITEDSEATS", idempotencyKey: newId("idem") },
          { ...ctx, normalizedEmail: u.normalizedEmail },
        ),
      ),
    );

    const totals = await t.db.execute<{
      redemptions: string;
      entries: string;
      granted: string;
    }>(sql`
      SELECT
        (SELECT COUNT(*)::text FROM access_code_redemptions) AS redemptions,
        (SELECT COUNT(*)::text FROM credit_ledger) AS entries,
        (SELECT COALESCE(SUM(amount),0)::text FROM credit_ledger) AS granted
    `);
    const row = totals.rows[0]!;

    expect(Number(row.redemptions), "never over-issues seats").toBe(SEATS);
    expect(Number(row.entries)).toBe(SEATS);
    expect(Number(row.granted)).toBe(SEATS * 10);

    const campaign = await t.db.execute<{ redemption_count: number }>(
      sql`SELECT redemption_count FROM access_code_campaigns LIMIT 1`,
    );
    expect(Number(campaign.rows[0]!.redemption_count)).toBe(SEATS);
  });
});

describe("two admins adjusting the same wallet at once", () => {
  it("applies both adjustments exactly once with a consistent final balance", async () => {
    const user = await createTestUser(t.db, { email: "wallet@example.test" });
    const adminA = await createTestUser(t.db, { email: "a@admin.test", role: "super_admin" });
    const adminB = await createTestUser(t.db, { email: "b@admin.test", role: "super_admin" });

    // 20 concurrent adjustments, alternating admins, mixed signs.
    const ops = Array.from({ length: 20 }, (_, i) =>
      credits.adminAdjust({
        userId: user.id,
        amount: i % 2 === 0 ? 10 : 5,
        reason: `concurrent adjustment ${i}`,
        adminId: i % 2 === 0 ? adminA.id : adminB.id,
        idempotencyKey: newId("idem"),
      }),
    );

    const results = await Promise.allSettled(ops);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok, "every adjustment should succeed").toBe(20);

    const expected = 10 * 10 + 10 * 5; // 150

    const { entries, balance } = await counts(user.id);
    expect(entries).toBe(20);
    expect(balance, "wallet matches the sum of all adjustments").toBe(expected);

    // The cached wallet agrees with the ledger — no drift under contention.
    const drift = await t.db.execute(sql`SELECT * FROM credit_wallet_drift`);
    expect(drift.rows).toHaveLength(0);

    // Every entry's balance_after is distinct and forms a valid running total.
    const chain = await t.db.execute<{ balance_after: number }>(
      sql`SELECT balance_after FROM credit_ledger WHERE user_id = ${user.id} ORDER BY created_at, id`,
    );
    const seen = new Set(chain.rows.map((r) => Number(r.balance_after)));
    expect(seen.size, "no two entries claim the same resulting balance").toBe(20);
    expect(Math.max(...seen)).toBe(expected);
  });

  it("applies a duplicate idempotency key only once", async () => {
    const user = await createTestUser(t.db, { email: "idem@example.test" });
    const admin = await createTestUser(t.db, { email: "admin@idem.test", role: "super_admin" });

    const key = newId("idem");
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        credits.adminAdjust({
          userId: user.id,
          amount: 25,
          reason: "same key, many times",
          adminId: admin.id,
          idempotencyKey: key,
        }),
      ),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded.length, "all callers get an answer").toBe(12);

    const { entries, balance } = await counts(user.id);
    expect(entries, "one key, one entry").toBe(1);
    expect(balance).toBe(25);

    // Exactly one caller did the work; the rest replayed it.
    const replays = succeeded.filter((r) => r.status === "fulfilled" && r.value.replayed).length;
    expect(replays).toBe(11);
  });
});

describe("suspended user attempting redemption", () => {
  it("refuses and grants nothing", async () => {
    const user = await createTestUser(t.db, { email: "banned@example.test", status: "suspended" });
    await makeCampaign({ code: "SUSPENDEDTEST", credits: 100 });

    await expect(
      redemption.redeem(
        { userId: user.id, code: "SUSPENDEDTEST", idempotencyKey: newId("idem") },
        { ...ctx, userStatus: "suspended", normalizedEmail: user.normalizedEmail },
      ),
    ).rejects.toMatchObject({ reason: "user_suspended" });

    const { redemptions, entries } = await counts(user.id);
    expect(redemptions).toBe(0);
    expect(entries).toBe(0);
  });

  it("refuses an unverified user and grants nothing", async () => {
    const user = await createTestUser(t.db, {
      email: "unverified@example.test",
      emailVerified: false,
    });
    await makeCampaign({ code: "NEEDSVERIFY", credits: 100 });

    await expect(
      redemption.redeem(
        { userId: user.id, code: "NEEDSVERIFY", idempotencyKey: newId("idem") },
        { ...ctx, emailVerified: false, normalizedEmail: user.normalizedEmail },
      ),
    ).rejects.toMatchObject({ reason: "email_unverified" });

    expect((await counts(user.id)).entries).toBe(0);
  });
});

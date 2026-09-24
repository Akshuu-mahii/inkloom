/**
 * The console must count ONE population.
 *
 * It did not. `total_users` excluded erased accounts and nothing else did, so
 * the overview reported 4 total users and 102 signups this week — from the same
 * table, on the same screen — and drew a funnel step at 10200%. Staging had 98
 * erased accounts left by a load test and the erasure drills behind it.
 *
 * An erased account is a tombstone: the row survives so the ledger and the
 * audit trail still resolve, and the person is gone. Anything describing the
 * live platform has to leave them out, and the failure mode is silent — every
 * number is individually defensible, and only the contradiction between two of
 * them reveals the mismatch. So the assertions below are relational: whatever
 * the numbers are, the ones that describe a subset must never exceed the ones
 * that describe the whole.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestApp, extractToken, type TestApp } from "../../../../../tests/helpers/app";

let app: TestApp;

beforeAll(() => {
  app = createTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await app.reset();
});

const PASSWORD = "a-perfectly-fine-passphrase-1";

async function signupAndVerify(email: string): Promise<string[]> {
  await app.json("/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: PASSWORD, name: "Test Person", acceptedTerms: true }),
  });
  const token = extractToken(app.mail.lastTo(email)!.html);
  await app.json("/v1/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) });
  const login = await app.json("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return login.cookies;
}

/** A signed-in staff session, promoted after login. See security.security.test.ts. */
async function staffCookies(email: string): Promise<string[]> {
  const cookies = await signupAndVerify(email);
  await app.db.db.execute(
    sql`UPDATE users SET role = 'super_admin', two_factor_enabled = true WHERE email = ${email}`,
  );
  return cookies;
}

interface Overview {
  users: { total: number; verified: number; signupsToday: number; signupsWeek: number };
  sessions: { active: number };
  credits: { granted: number; outstanding: number };
  redemptions: {
    successful: number;
    failed: number;
    failuresByReason: Array<{ reason: string; count: number }>;
  };
  funnel: { signupCompleted: number; emailVerified: number; codeRedeemed: number };
}

/** The timezone the console cuts its calendar periods on. Must track the route. */
const REPORTING_TIME_ZONE = "Asia/Kolkata";

/** The local wall-clock hour, in the reporting timezone, right now. */
function hourHereNow(): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: REPORTING_TIME_ZONE,
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
  );
}

async function overview(cookies: string[]): Promise<Overview> {
  const result = await app.json<Overview>("/v1/admin/overview", { cookies });
  expect(result.status, "the console must load").toBe(200);
  return result.data!;
}

// ===========================================================================

describe("erased accounts are not counted as people", () => {
  it("leaves them out of every user total, not just the headline one", async () => {
    const staff = await staffCookies("owner@example.test");
    await signupAndVerify("leaver@example.test");

    const before = await overview(staff);
    expect(before.users.total).toBe(2);
    expect(before.users.signupsWeek).toBe(2);

    // Erase exactly as account deletion does: the row stays, the status changes.
    await app.db.db.execute(
      sql`UPDATE users SET status = 'deleted', anonymized_at = now()
           WHERE email = 'leaver@example.test'`,
    );

    const after = await overview(staff);
    expect(after.users.total, "the headline drops").toBe(1);
    expect(after.users.signupsWeek, "and so does every other count of people").toBe(1);
    expect(after.users.signupsToday).toBe(1);
    expect(after.users.verified).toBe(1);
  });

  it("leaves them out of the funnel", async () => {
    const staff = await staffCookies("owner2@example.test");
    await signupAndVerify("gone@example.test");

    await app.db.db.execute(
      sql`UPDATE users SET status = 'deleted', anonymized_at = now() WHERE email = 'gone@example.test'`,
    );

    const data = await overview(staff);
    expect(data.funnel.signupCompleted, "a tombstone did not complete signup").toBe(1);
    expect(data.funnel.emailVerified).toBe(1);
  });

  it("leaves their credits out of the totals", async () => {
    const staff = await staffCookies("owner3@example.test");
    await signupAndVerify("rich@example.test");

    // Give the departing account a balance the console would otherwise report
    // as money the platform still owes somebody.
    await app.db.db.execute(sql`
      INSERT INTO credit_ledger
             (id, user_id, wallet_id, amount, type, balance_after,
              reference_type, reason, actor_type, idempotency_key, metadata)
      SELECT 'led_' || u.id, u.id, w.id, 500, 'ADMIN_GRANT', 500,
             'admin_adjustment', 'test fixture', 'system', 'k_' || u.id, '{}'::jsonb
        FROM users u JOIN credit_wallets w ON w.user_id = u.id
       WHERE u.email = 'rich@example.test'
    `);
    await app.db.db.execute(sql`
      UPDATE credit_wallets SET balance = 500
       WHERE user_id = (SELECT id FROM users WHERE email = 'rich@example.test')
    `);

    const before = await overview(staff);
    expect(before.credits.outstanding).toBeGreaterThanOrEqual(500);

    await app.db.db.execute(
      sql`UPDATE users SET status = 'deleted', anonymized_at = now() WHERE email = 'rich@example.test'`,
    );

    const after = await overview(staff);
    expect(after.credits.outstanding, "an erased wallet is not a live liability").toBe(0);
    expect(after.credits.granted, "nor a live grant").toBe(0);
  });
});

describe("the numbers agree with each other", () => {
  it("never reports more recent signups than users", async () => {
    const staff = await staffCookies("owner4@example.test");
    await signupAndVerify("a@example.test");
    await signupAndVerify("b@example.test");
    await app.db.db.execute(
      sql`UPDATE users SET status = 'deleted', anonymized_at = now() WHERE email = 'b@example.test'`,
    );

    const data = await overview(staff);

    // The contradiction that gave this file its reason to exist: 4 total users
    // and 102 signups this week, from one table.
    expect(data.users.signupsWeek).toBeLessThanOrEqual(data.users.total);
    expect(data.users.signupsToday).toBeLessThanOrEqual(data.users.signupsWeek);
    expect(data.users.verified).toBeLessThanOrEqual(data.users.total);
    expect(data.funnel.signupCompleted).toBe(data.users.total);
    expect(data.funnel.emailVerified).toBe(data.users.verified);
  });
});

describe("the periods on the page are the periods on the label", () => {
  it("counts 'today' from local midnight, not from this time yesterday", async () => {
    /*
     * The bug: "Signups today" was `created_at >= now() - 24 hours`. That is a
     * window sliding backwards all day, so at nine in the evening it was still
     * counting people who joined at eight the previous evening — and the number
     * fell as the day went on rather than rising, which is the opposite of what
     * the label promises.
     *
     * Backdated by twenty hours: inside a rolling day, and outside the calendar
     * one for every local hour before 20:00. Before that the two windows
     * genuinely overlap and there is nothing to tell apart, so the assertion
     * only runs when the distinction exists.
     */
    const staff = await staffCookies("periods@example.test");
    await signupAndVerify("yesterday-evening@example.test");

    await app.db.db.execute(
      sql`UPDATE users SET created_at = now() - interval '20 hours'
           WHERE email = 'yesterday-evening@example.test'`,
    );

    const data = await overview(staff);

    if (hourHereNow() < 20) {
      expect(
        data.users.signupsToday,
        "a signup from before local midnight is not a signup today",
      ).toBe(1);
    }
    // Either way it is still this week, and still a user.
    expect(data.users.signupsWeek).toBe(2);
    expect(data.users.total).toBe(2);
  });

  it("keeps 'today' inside 'this week' inside the total", async () => {
    const staff = await staffCookies("nesting@example.test");
    await signupAndVerify("one@example.test");

    const data = await overview(staff);
    expect(data.users.signupsToday).toBeLessThanOrEqual(data.users.signupsWeek);
    expect(data.users.signupsWeek).toBeLessThanOrEqual(data.users.total);
  });
});

describe("failed redemptions are reported as failures, with their reasons", () => {
  /**
   * Record a redemption failure the way the redeem route does.
   *
   * The casts are load-bearing: without them Postgres cannot infer a type for a
   * bare parameter in this position and refuses to plan the statement at all
   * (42P18), which shows up as an opaque serialised error rather than a test
   * failure you can read.
   */
  async function recordFailure(email: string, reason: string): Promise<void> {
    await app.db.db.execute(sql`
      INSERT INTO security_events (id, type, severity, user_id, metadata)
      VALUES ('sec_' || md5(random()::text), 'access_code_failed', 'info',
              (SELECT id FROM users WHERE email = ${email}::text),
              jsonb_build_object('reason', ${reason}::text))
    `);
  }

  it("breaks the total down by reason so the number means something", async () => {
    /*
     * The console called this "Blocked attempts" and printed it in alert red,
     * so a week of people mistyping their code read as an attack. The total is
     * only interpretable next to the reasons behind it.
     */
    const staff = await staffCookies("reasons@example.test");
    await signupAndVerify("fumbler@example.test");

    await recordFailure("fumbler@example.test", "unknown_code");
    await recordFailure("fumbler@example.test", "unknown_code");
    await recordFailure("fumbler@example.test", "duplicate");

    const data = await overview(staff);
    expect(data.redemptions.failed).toBe(3);
    expect(data.redemptions.failuresByReason).toEqual([
      { reason: "unknown_code", count: 2 },
      { reason: "duplicate", count: 1 },
    ]);
  });

  it("leaves erased accounts out, like every other count on the page", async () => {
    /*
     * The one number on the overview that never excluded tombstones. A load
     * test's failed redemptions stayed in it forever, which is how a count of
     * people fumbling their codes ended up describing a fixture.
     */
    const staff = await staffCookies("erased-failures@example.test");
    await signupAndVerify("fixture@example.test");
    await recordFailure("fixture@example.test", "unknown_code");

    expect((await overview(staff)).redemptions.failed).toBe(1);

    await app.db.db.execute(
      sql`UPDATE users SET status = 'deleted', anonymized_at = now()
           WHERE email = 'fixture@example.test'`,
    );

    const after = await overview(staff);
    expect(after.redemptions.failed, "a tombstone did not fumble a code").toBe(0);
    expect(after.redemptions.failuresByReason).toEqual([]);
  });

  it("does not count an erased account's sessions as active", async () => {
    /*
     * `active_sessions` was the other count on this page that never excluded
     * tombstones — it read the sessions table without ever looking at who the
     * session belonged to. Signing up, verifying and logging in can each leave
     * a session behind, so the drop is measured rather than assumed to be one.
     */
    const staff = await staffCookies("erased-sessions@example.test");
    await signupAndVerify("signed-in@example.test");

    const before = (await overview(staff)).sessions.active;
    const theirs = await app.db.db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE u.email = 'signed-in@example.test' AND s.revoked_at IS NULL AND s.expires_at > now()
    `);
    const owned = Number(theirs.rows[0]?.count ?? 0);
    expect(owned, "the account under test must actually be signed in").toBeGreaterThan(0);

    await app.db.db.execute(
      sql`UPDATE users SET status = 'deleted', anonymized_at = now()
           WHERE email = 'signed-in@example.test'`,
    );

    expect((await overview(staff)).sessions.active, "nobody is signed in to a tombstone").toBe(
      before - owned,
    );
  });
});

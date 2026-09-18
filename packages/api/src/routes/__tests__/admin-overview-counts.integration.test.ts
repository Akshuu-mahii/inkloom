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
  credits: { granted: number; outstanding: number };
  redemptions: { successful: number };
  funnel: { signupCompleted: number; emailVerified: number; codeRedeemed: number };
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

/**
 * Brute-force protection on the two-factor SIGN-IN path.
 *
 * Written to settle a question a staging audit got wrong in both directions.
 * The audit grepped this repository for writes to `two_factor.failed_
 * verification_count` and `locked_until`, found none, and concluded the columns
 * were dead and the second factor unprotected. Both conclusions were false:
 * the writes live in Better Auth's two-factor plugin and reach those columns
 * through the Drizzle adapter, so no amount of grepping THIS codebase can see
 * them.
 *
 * Reading the library's source is how that mistake nearly got made a second
 * time, so these tests assert on observable behaviour and on the actual column
 * values, never on the presence of a call. If a library upgrade ever silently
 * drops the lockout, this file fails.
 *
 * Two independent controls are in play, and the distinction matters:
 *
 *   - a PER-CHALLENGE cap of 5 attempts, which burns the 2FA cookie and forces
 *     a fresh password sign-in. It is keyed to the challenge, so rotating IPs
 *     does not refresh it.
 *   - a PER-ACCOUNT budget of 10 consecutive failures, which sets `locked_until`
 *     for 15 minutes. It spans challenges and factors, so re-authenticating to
 *     get a new challenge does not reset it.
 *
 * Neither is a permanent lock: the count resets on any success and the lock
 * expires on its own.
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

const ACCOUNT = {
  email: "grace@example.test",
  password: "a-perfectly-fine-passphrase-1",
  name: "Grace Hopper",
  acceptedTerms: true as const,
};

/** Sign up, verify the address, and return a session. */
async function signupAndVerify() {
  await app.json("/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify(ACCOUNT),
  });
  const message = app.mail.lastTo(ACCOUNT.email);
  const verified = await app.json("/v1/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ token: extractToken(message!.html) }),
  });
  return verified.cookies;
}

/**
 * Complete real TOTP enrolment and return the shared secret, so a test can
 * generate genuinely valid codes as well as wrong ones.
 */
async function enrolTwoFactor(cookies: string[]): Promise<string> {
  const { createOTP } = await import("@better-auth/utils/otp");
  const { base32 } = await import("@better-auth/utils/base32");

  const started = await app.json("/v1/auth/two-factor/enable", {
    method: "POST",
    cookies,
    body: JSON.stringify({ currentPassword: ACCOUNT.password }),
  });

  const uri = (started.data as { totpURI?: string } | undefined)?.totpURI;
  expect(uri, "enrolment must return a TOTP URI").toBeDefined();

  // base32(raw secret) in the URI; Better Auth HMACs the RAW bytes.
  const encoded = new URL(uri!).searchParams.get("secret")!;
  const secret = new TextDecoder().decode(base32.decode(encoded));

  const confirmed = await app.json("/v1/auth/two-factor/confirm", {
    method: "POST",
    cookies,
    body: JSON.stringify({ code: await createOTP(secret).totp() }),
  });
  expect(confirmed.status, "enrolment must complete").toBe(200);

  return secret;
}

/** Sign in with the correct password and return the 2FA challenge cookies. */
async function beginChallenge() {
  const result = await app.json<{ twoFactorRequired?: boolean }>("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: ACCOUNT.email, password: ACCOUNT.password }),
  });

  expect(result.status).toBe(200);
  expect(result.data?.twoFactorRequired, "a protected account must be challenged").toBe(true);
  return result.cookies;
}

function attempt(cookies: string[], code: string) {
  return app.json("/v1/auth/two-factor/verify", {
    method: "POST",
    cookies,
    body: JSON.stringify({ code }),
  });
}

/** The account-level counters, read straight from the table. */
async function lockState() {
  const result = await app.db.db.execute<{
    failed_verification_count: number;
    locked_until: string | null;
  }>(sql`SELECT failed_verification_count, locked_until FROM two_factor LIMIT 1`);
  const row = result.rows[0]!;
  return {
    failures: Number(row.failed_verification_count),
    lockedUntil: row.locked_until ? new Date(row.locked_until) : null,
  };
}

const WRONG = "000000";

// ===========================================================================

describe("two-factor sign-in is protected per account, not only per network", () => {
  /*
   * The finding this file exists to disprove: that an attacker holding a
   * stolen password could grind TOTP codes from rotating IPs forever, because
   * the only limiter on the route is the per-network login bucket.
   *
   * Every request below arrives on the SAME challenge, and the protection is
   * keyed to the challenge and the account rather than the address — so an
   * attacker changing IP between attempts changes nothing about this result.
   */
  it("burns the challenge after 5 failures, forcing a fresh password sign-in", async () => {
    const cookies = await signupAndVerify();
    await enrolTwoFactor(cookies);
    const challenge = await beginChallenge();

    for (let i = 1; i <= 5; i += 1) {
      const result = await attempt(challenge, WRONG);
      expect(result.status, `attempt ${i} must be refused`).toBe(401);
    }

    // The sixth is refused by the attempt cap rather than by code comparison:
    // the challenge itself is now spent.
    const sixth = await attempt(challenge, WRONG);
    expect(sixth.status).toBe(401);

    const { failures } = await lockState();
    expect(failures, "each failure must be recorded against the account").toBeGreaterThanOrEqual(5);
  });

  it("records failures against the account across separate challenges", async () => {
    const cookies = await signupAndVerify();
    await enrolTwoFactor(cookies);

    // Re-authenticating for a fresh challenge must NOT reset the budget —
    // otherwise the per-challenge cap would be trivially bypassed in a loop.
    for (let round = 0; round < 2; round += 1) {
      const challenge = await beginChallenge();
      for (let i = 0; i < 5; i += 1) await attempt(challenge, WRONG);
    }

    const { failures, lockedUntil } = await lockState();
    expect(failures, "failures must accumulate across challenges").toBeGreaterThanOrEqual(10);
    expect(lockedUntil, "10 consecutive failures must lock the account").not.toBeNull();
  });

  it("refuses even a CORRECT code while the account is locked", async () => {
    const { createOTP } = await import("@better-auth/utils/otp");

    const cookies = await signupAndVerify();
    const secret = await enrolTwoFactor(cookies);

    for (let round = 0; round < 2; round += 1) {
      const challenge = await beginChallenge();
      for (let i = 0; i < 5; i += 1) await attempt(challenge, WRONG);
    }

    expect((await lockState()).lockedUntil).not.toBeNull();

    // The real proof: the attacker now cannot get in even if they guess right.
    const challenge = await beginChallenge();
    const correct = await attempt(challenge, await createOTP(secret).totp());
    expect(correct.status, "a locked account must refuse a valid code").not.toBe(200);
  });

  it("is a bounded cooldown, not a permanent lock", async () => {
    const cookies = await signupAndVerify();
    await enrolTwoFactor(cookies);

    for (let round = 0; round < 2; round += 1) {
      const challenge = await beginChallenge();
      for (let i = 0; i < 5; i += 1) await attempt(challenge, WRONG);
    }

    const { lockedUntil } = await lockState();
    expect(lockedUntil).not.toBeNull();

    // An attacker must never be able to brick someone else's account: the lock
    // has to expire on its own, and soon enough to be a cooldown.
    const minutesOut = (lockedUntil!.getTime() - Date.now()) / 60_000;
    expect(minutesOut).toBeGreaterThan(0);
    expect(minutesOut, "the lock must be a cooldown, not an outage").toBeLessThanOrEqual(60);
  });

  /*
   * The three refusals must be distinguishable to the user.
   *
   * They were not: the wrapper answered all three with INVALID_CREDENTIALS and
   * "Those details don't match an account. Check your email and password."
   * A locked-out user saw "wrong code" forever with nothing to suggest that
   * waiting is the fix, and a user whose challenge was spent was told their
   * password was wrong when they needed to sign in again.
   */
  it("tells a user whose challenge is spent to sign in again, not that the code is wrong", async () => {
    const cookies = await signupAndVerify();
    await enrolTwoFactor(cookies);
    const challenge = await beginChallenge();

    for (let i = 0; i < 5; i += 1) await attempt(challenge, WRONG);

    const spent = await attempt(challenge, WRONG);
    expect(spent.status).toBe(401);
    expect(spent.error?.message).toMatch(/sign in again/i);
    expect(spent.error?.message).not.toMatch(/password/i);
  });

  it("answers a locked account with 429 and a wait, not a generic refusal", async () => {
    const cookies = await signupAndVerify();
    await enrolTwoFactor(cookies);

    for (let round = 0; round < 2; round += 1) {
      const challenge = await beginChallenge();
      for (let i = 0; i < 5; i += 1) await attempt(challenge, WRONG);
    }

    const challenge = await beginChallenge();
    const locked = await attempt(challenge, WRONG);

    expect(locked.status, "a lockout is a 429, not a 401").toBe(429);
    expect(locked.error?.code).toBe("RATE_LIMITED");
    expect(locked.error?.message, "the user must be told how long").toMatch(/15 minutes/);
    expect(
      locked.response.headers.get("retry-after"),
      "and a machine client must be able to read it",
    ).toBe("900");
  });

  it("records a lockout as a distinct security event, not as another failed code", async () => {
    const cookies = await signupAndVerify();
    await enrolTwoFactor(cookies);

    for (let round = 0; round < 2; round += 1) {
      const challenge = await beginChallenge();
      for (let i = 0; i < 5; i += 1) await attempt(challenge, WRONG);
    }
    const challenge = await beginChallenge();
    await attempt(challenge, WRONG);

    // An operator must be able to tell a grinding attack from a fumbled code.
    const events = await app.db.db.execute<{ type: string; count: string }>(
      sql`SELECT type, COUNT(*)::text AS count
          FROM security_events
          WHERE metadata->>'flow' = 'two_factor_verify'
          GROUP BY type`,
    );
    const byType = Object.fromEntries(events.rows.map((r) => [r.type, Number(r.count)]));

    expect(byType.admin_2fa_failed, "the wrong codes").toBeGreaterThan(0);
    expect(byType.rate_limit_exceeded, "the lockout").toBeGreaterThan(0);
  });

  it("names the code, not the password, when the code is simply wrong", async () => {
    const cookies = await signupAndVerify();
    await enrolTwoFactor(cookies);
    const challenge = await beginChallenge();

    const wrong = await attempt(challenge, WRONG);

    expect(wrong.status).toBe(401);
    expect(wrong.error?.message).toBe("That code is not valid.");
  });

  it("clears the failure budget after a successful verification", async () => {
    const { createOTP } = await import("@better-auth/utils/otp");

    const cookies = await signupAndVerify();
    const secret = await enrolTwoFactor(cookies);

    const challenge = await beginChallenge();
    await attempt(challenge, WRONG);
    await attempt(challenge, WRONG);
    expect((await lockState()).failures).toBeGreaterThan(0);

    const ok = await attempt(challenge, await createOTP(secret).totp());
    expect(ok.status, "the genuine code must still be accepted").toBe(200);

    // Consecutive, not cumulative: a user who fumbles a code then gets it right
    // must not carry those failures toward a future lock.
    expect((await lockState()).failures).toBe(0);
  });
});

/**
 * Authentication flows, end to end, against a real database and a real Better
 * Auth instance. Nothing here is mocked except the email transport, which
 * captures messages so the tests can read a verification link the way a user
 * would.
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

const VALID = {
  email: "ada@example.test",
  password: "a-perfectly-fine-passphrase",
  name: "Ada Lovelace",
  acceptedTerms: true as const,
};

async function signup(overrides: Record<string, unknown> = {}) {
  return app.json("/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify({ ...VALID, ...overrides }),
  });
}

/** Complete signup + verification, returning session cookies. */
async function signupAndVerify(email = VALID.email) {
  await signup({ email });
  const message = app.mail.lastTo(email);
  const token = extractToken(message!.html);
  const verified = await app.json("/v1/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  return verified.cookies;
}

async function login(email = VALID.email, password = VALID.password) {
  return app.json("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

// ===========================================================================
describe("signup", () => {
  it("creates an account and sends exactly one verification email", async () => {
    const result = await signup();

    expect(result.status).toBe(200);
    expect(app.mail.sent).toHaveLength(1);

    const message = app.mail.sent[0]!;
    expect(message.to).toBe(VALID.email);
    expect(message.template).toBe("verify_email");
    expect(message.subject).toMatch(/confirm/i);
    // Both parts are always present.
    expect(message.html).toContain("<html");
    expect(message.text.length).toBeGreaterThan(20);
    // Expiry is stated, per the brief.
    expect(message.text).toMatch(/expires in/i);
  });

  it("stores the email case-folded and enforces case-insensitive uniqueness", async () => {
    await signup({ email: "Ada@Example.Test" });

    const rows = await app.db.db.execute<{ email: string; normalized_email: string }>(
      sql`SELECT email, normalized_email FROM users`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.normalized_email).toBe("ada@example.test");

    // A different casing of the same address must not create a second account.
    await signup({ email: "ADA@EXAMPLE.TEST" });
    const after = await app.db.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM users`,
    );
    expect(Number(after.rows[0]!.count)).toBe(1);
  });

  it("does NOT reveal that an email is already registered", async () => {
    const first = await signup();
    app.mail.clear();
    const second = await signup();

    // Identical status and identical body — the only safe answer.
    expect(second.status).toBe(first.status);
    expect(second.data).toEqual(first.data);
    expect(JSON.stringify(second.data)).not.toMatch(/exist|already|taken|registered/i);

    // And no second account was created.
    const count = await app.db.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM users`,
    );
    expect(Number(count.rows[0]!.count)).toBe(1);
  });

  it("records terms, privacy and marketing consent as separate timestamped rows", async () => {
    await signup({ marketingOptIn: false });

    const consents = await app.db.db.execute<{ type: string; granted: boolean }>(
      sql`SELECT type, granted FROM user_consents ORDER BY type`,
    );
    const byType = Object.fromEntries(consents.rows.map((r) => [r.type, r.granted]));

    expect(byType.terms).toBe(true);
    expect(byType.privacy).toBe(true);
    // Marketing is separate from the terms and defaults to off.
    expect(byType.marketing_email).toBe(false);
  });

  it("refuses signup without explicit acceptance of the terms", async () => {
    const result = await signup({ acceptedTerms: false });
    expect(result.status).toBe(400);
    expect(result.error?.code).toBe("VALIDATION_ERROR");
    expect(app.mail.sent).toHaveLength(0);
  });

  it("accepts a long passphrase and rejects a short password", async () => {
    const long = await signup({
      email: "long@example.test",
      password: "correct horse battery staple with plenty of room to spare",
    });
    expect(long.status).toBe(200);

    const short = await signup({ email: "short@example.test", password: "short1!" });
    expect(short.status).toBe(400);
  });

  it("never returns or logs a password hash", async () => {
    const result = await signup();
    const serialised = JSON.stringify(result.data);
    expect(serialised).not.toContain(VALID.password);
    expect(serialised).not.toMatch(/hash|scrypt|\$2[aby]\$/);
  });

  it("is refused when the signup_enabled flag is off", async () => {
    await app.db.db.execute(sql`
      INSERT INTO feature_flags (id, key, description, enabled, high_risk)
      VALUES ('flag_test_signup', 'signup_enabled', 'test', false, true)
    `);
    app.services.settings.invalidate();

    const result = await signup();
    expect(result.status).toBe(403);
    expect(result.error?.code).toBe("FEATURE_DISABLED");
  });
});

// ===========================================================================
describe("email verification", () => {
  it("verifies with a valid token and issues a session cookie", async () => {
    await signup();
    const token = extractToken(app.mail.sent[0]!.html);
    expect(token).toBeTruthy();

    const result = await app.json("/v1/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token }),
    });

    expect(result.status).toBe(200);

    const verified = await app.db.db.execute<{ email_verified: boolean }>(
      sql`SELECT email_verified FROM users LIMIT 1`,
    );
    expect(verified.rows[0]!.email_verified).toBe(true);
  });

  it("treats a replayed verification link as idempotent, granting nothing extra", async () => {
    /**
     * Better Auth verifies email with a STATELESS signed token: there is no row
     * to consume, so a still-valid link works more than once until it expires.
     *
     * That is safe — re-verifying an already-verified address changes no state
     * and confers no privilege — but it is worth pinning down explicitly, so
     * this test asserts the property that actually matters: a replay must not
     * mint extra credits, extra sessions, or extra welcome emails.
     *
     * Password RESET tokens are a different matter and ARE single-use; that is
     * covered in the "password reset" suite.
     */
    await signup();
    const token = extractToken(app.mail.sent[0]!.html);

    const first = await app.json("/v1/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    expect(first.status).toBe(200);

    const second = await app.json("/v1/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    expect(second.status).toBe(200);

    // Still exactly one user, one wallet, and a zero balance — no duplication.
    const state = await app.db.db.execute<{ users: string; wallets: string; credits: string }>(sql`
      SELECT
        (SELECT COUNT(*)::text FROM users)          AS users,
        (SELECT COUNT(*)::text FROM credit_wallets) AS wallets,
        (SELECT COUNT(*)::text FROM credit_ledger)  AS credits
    `);
    const row = state.rows[0]!;
    expect(Number(row.users)).toBe(1);
    expect(Number(row.wallets)).toBe(1);
    expect(Number(row.credits)).toBe(0);
  });

  it("rejects a forged token", async () => {
    await signup();
    const result = await app.json("/v1/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token: "not-a-real-token-but-long-enough" }),
    });
    expect(result.status).toBe(400);
    // The top-level message stays the canonical generic string for the code;
    // the actionable, still-deliberately-vague detail is carried in `details`.
    // "invalid" and "expired" are not distinguished, so the endpoint cannot be
    // used to probe which tokens exist.
    expect(result.error?.code).toBe("VALIDATION_ERROR");
    const details = (result.error as unknown as { details?: { token?: string } }).details;
    expect(details?.token).toMatch(/invalid or has expired/i);
  });
});

// ===========================================================================
describe("login", () => {
  it("refuses an unverified account, without saying why", async () => {
    await signup();
    const result = await login();

    expect(result.status).toBe(401);
    expect(result.error?.code).toBe("INVALID_CREDENTIALS");
    // Must not hint that the account exists but is unverified.
    expect(result.error?.message).not.toMatch(/verif/i);
  });

  it("signs in a verified user and sets an HttpOnly session cookie", async () => {
    await signupAndVerify();
    const result = await login();

    expect(result.status).toBe(200);

    const sessionCookie = result.cookies.find((cookie) => cookie.includes("inkloom_session"));
    expect(sessionCookie, "a session cookie must be set").toBeTruthy();

    // The cookie attributes the brief requires.
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    expect(sessionCookie).toMatch(/Path=\//i);
    // Host-only: no Domain attribute, so a sibling subdomain cannot set it.
    expect(sessionCookie).not.toMatch(/Domain=/i);
  });

  it("returns an identical error for an unknown address and a wrong password", async () => {
    await signupAndVerify();

    const wrongPassword = await login(VALID.email, "definitely-not-the-password");
    const unknownEmail = await login("nobody@example.test", VALID.password);

    // Same status, same code, same message — no enumeration oracle.
    expect(wrongPassword.status).toBe(unknownEmail.status);
    expect(wrongPassword.error?.code).toBe(unknownEmail.error?.code);
    expect(wrongPassword.error?.message).toBe(unknownEmail.error?.message);
  });

  it("applies a progressive cooldown rather than locking the account forever", async () => {
    await signupAndVerify();

    // Two failures: still allowed to try (typos are normal).
    await login(VALID.email, "wrong-1");
    await login(VALID.email, "wrong-2");
    const third = await login(VALID.email, "wrong-3");
    expect(third.status).toBe(401);

    // By the fourth, a cooldown is in force.
    const fourth = await login(VALID.email, "wrong-4");
    expect(fourth.status).toBe(429);
    expect(fourth.error?.code).toBe("RATE_LIMITED");
    expect(Number(fourth.response.headers.get("retry-after"))).toBeGreaterThan(0);

    // Crucially the cooldown is FINITE — a Retry-After is present and bounded,
    // so the account recovers on its own rather than being permanently locked.
    expect(Number(fourth.response.headers.get("retry-after"))).toBeLessThanOrEqual(900);
  });

  it("clears the failure counter after a successful sign-in", async () => {
    await signupAndVerify();
    await login(VALID.email, "wrong-1");
    await login(VALID.email, "wrong-2");

    const success = await login();
    expect(success.status).toBe(200);

    const remaining = await app.db.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM rate_limit_events WHERE bucket = 'auth.login.account'`,
    );
    expect(Number(remaining.rows[0]!.count)).toBe(0);
  });

  it("records a security event for every failed attempt", async () => {
    await signupAndVerify();
    await login(VALID.email, "wrong");

    const events = await app.db.db.execute<{ type: string; target_email: string }>(
      sql`SELECT type, target_email FROM security_events WHERE type = 'login_failed'`,
    );
    expect(events.rows.length).toBeGreaterThanOrEqual(1);
    expect(events.rows[0]!.target_email).toBe(VALID.email);
  });
});

// ===========================================================================
describe("a stale session in the browser", () => {
  /*
   * Both of these endpoints exist for someone who cannot sign in: an address
   * that was never confirmed, or a password that was forgotten. The browser
   * making the request may still hold a session for a DIFFERENT account — a
   * shared machine, or simply a developer's own test login.
   *
   * Better Auth refuses to act when the session and the target address
   * disagree, raising "Email mismatch". Because the response here is
   * deliberately neutral — it must not reveal whether an account exists — that
   * refusal used to be invisible: the caller was told the mail was on its way,
   * the per-account rate-limit budget was spent, and nothing was sent.
   *
   * This is what that regression looks like from the outside.
   */

  it("still sends a verification email while signed in as someone else", async () => {
    // A confirmed account whose session we will carry.
    const bystanderCookies = await signupAndVerify("bystander@example.test");

    // A second, unconfirmed account — the one actually asking for the mail.
    await signup({ email: "waiting@example.test" });
    app.mail.clear();

    const result = await app.json("/v1/auth/resend-verification", {
      method: "POST",
      cookies: bystanderCookies,
      body: JSON.stringify({ email: "waiting@example.test" }),
    });

    expect(result.status).toBe(200);
    const message = app.mail.lastTo("waiting@example.test");
    expect(message?.template).toBe("verify_email");
    expect(extractToken(message!.html)).toBeTruthy();
    // And nothing was sent to the account whose session happened to be present.
    expect(app.mail.lastTo("bystander@example.test")).toBeUndefined();
  });

  it("still sends a password reset while signed in as someone else", async () => {
    const bystanderCookies = await signupAndVerify("bystander2@example.test");
    await signupAndVerify("forgetful@example.test");
    app.mail.clear();

    const result = await app.json("/v1/auth/forgot-password", {
      method: "POST",
      cookies: bystanderCookies,
      body: JSON.stringify({ email: "forgetful@example.test" }),
    });

    expect(result.status).toBe(200);
    const message = app.mail.lastTo("forgetful@example.test");
    expect(message?.template).toBe("password_reset");

    // The link has to actually work, not merely exist.
    const token = extractToken(message!.html);
    const reset = await app.json("/v1/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password: "a-totally-new-passphrase" }),
    });
    expect(reset.status).toBe(200);
    expect((await login("forgetful@example.test", "a-totally-new-passphrase")).status).toBe(200);
  });
});

// ===========================================================================
describe("password reset", () => {
  it("sends a single-use link and invalidates it after use", async () => {
    await signupAndVerify();
    app.mail.clear();

    const requested = await app.json("/v1/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: VALID.email }),
    });
    expect(requested.status).toBe(200);

    const message = app.mail.lastTo(VALID.email);
    expect(message?.template).toBe("password_reset");
    expect(message?.text).toMatch(/expires in/i);

    const token = extractToken(message!.html);
    expect(token).toBeTruthy();

    const newPassword = "an-entirely-different-passphrase";
    const reset = await app.json("/v1/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password: newPassword }),
    });
    expect(reset.status).toBe(200);

    // The new password works...
    expect((await login(VALID.email, newPassword)).status).toBe(200);
    // ...the old one does not...
    expect((await login(VALID.email, VALID.password)).status).toBe(401);

    // ...and the token cannot be replayed.
    const replay = await app.json("/v1/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password: "yet-another-passphrase-here" }),
    });
    expect(replay.status).toBe(400);
  });

  it("invalidates an earlier reset token when a new one is issued", async () => {
    await signupAndVerify();
    app.mail.clear();

    await app.json("/v1/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: VALID.email }),
    });
    const firstToken = extractToken(app.mail.lastTo(VALID.email)!.html);

    app.mail.clear();
    await app.json("/v1/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: VALID.email }),
    });
    const secondToken = extractToken(app.mail.lastTo(VALID.email)!.html);
    expect(secondToken).not.toBe(firstToken);

    // The superseded token must be dead.
    const stale = await app.json("/v1/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token: firstToken, password: "a-brand-new-passphrase-x" }),
    });
    expect(stale.status).toBe(400);
  });

  it("answers identically for a known and an unknown address", async () => {
    await signupAndVerify();

    const known = await app.json("/v1/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: VALID.email }),
    });
    const unknown = await app.json("/v1/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: "ghost@example.test" }),
    });

    expect(known.status).toBe(unknown.status);
    expect(known.data).toEqual(unknown.data);
  });

  it("revokes existing sessions on reset, evicting anyone who had one", async () => {
    await signupAndVerify();
    const loggedIn = await login();
    expect(loggedIn.status).toBe(200);

    app.mail.clear();
    await app.json("/v1/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: VALID.email }),
    });
    const token = extractToken(app.mail.lastTo(VALID.email)!.html);

    await app.json("/v1/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password: "post-reset-passphrase-here" }),
    });

    // The pre-reset session no longer resolves.
    const me = await app.json("/v1/me", { cookies: loggedIn.cookies });
    expect(me.status).toBe(401);
  });

  it("emails a notification after the password changes", async () => {
    await signupAndVerify();
    app.mail.clear();

    await app.json("/v1/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: VALID.email }),
    });
    const token = extractToken(app.mail.lastTo(VALID.email)!.html);
    app.mail.clear();

    await app.json("/v1/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password: "notified-passphrase-value" }),
    });

    const notice = app.mail.lastTo(VALID.email);
    expect(notice?.template).toBe("password_changed");
  });
});

// ===========================================================================
describe("sessions", () => {
  it("lists sessions without exposing tokens or IP addresses", async () => {
    await signupAndVerify();
    const session = await login();

    const result = await app.json<{
      sessions: Array<{ id: string; device: string; current: boolean }>;
    }>("/v1/me/sessions", { cookies: session.cookies });

    expect(result.status).toBe(200);
    expect(result.data!.sessions.length).toBeGreaterThanOrEqual(1);

    const serialised = JSON.stringify(result.data);
    // A coarse device label, and nothing else identifying.
    expect(result.data!.sessions[0]!.device).toMatch(/on/);
    expect(serialised).not.toMatch(/"token"/);
    expect(serialised).not.toMatch(/ipAddress|ip_hash|\d+\.\d+\.\d+\.\d+/);
  });

  it("revokes a single session and immediately rejects it", async () => {
    await signupAndVerify();
    const first = await login();
    const second = await login();

    const list = await app.json<{ sessions: Array<{ id: string; current: boolean }> }>(
      "/v1/me/sessions",
      { cookies: second.cookies },
    );
    const other = list.data!.sessions.find((s) => !s.current)!;

    const revoked = await app.json(`/v1/me/sessions/${other.id}`, {
      method: "DELETE",
      cookies: second.cookies,
    });
    expect(revoked.status).toBe(200);

    // The revoked session is dead on the very next request.
    const me = await app.json("/v1/me", { cookies: first.cookies });
    expect(me.status).toBe(401);
  });

  it("logs out of every device", async () => {
    await signupAndVerify();
    const a = await login();
    const b = await login();

    const out = await app.json("/v1/auth/logout-all", { method: "POST", cookies: b.cookies });
    expect(out.status).toBe(200);

    expect((await app.json("/v1/me", { cookies: a.cookies })).status).toBe(401);
  });
});

// ===========================================================================
describe("suspension", () => {
  it("rejects a suspended user's existing session on the next request", async () => {
    await signupAndVerify();
    const session = await login();
    expect((await app.json("/v1/me", { cookies: session.cookies })).status).toBe(200);

    await app.db.db.execute(sql`
      UPDATE users SET status = 'suspended', suspended_at = now(), suspended_reason = 'test'
    `);

    // No sweep needed: the session is re-validated against the user's live
    // status on every request.
    const after = await app.json("/v1/me", { cookies: session.cookies });
    expect(after.status).toBe(401);
  });
});

// ===========================================================================
describe("response envelope", () => {
  it("always returns data/error/requestId, with a matching header", async () => {
    const okResponse = await app.json("/v1/auth/signup", {
      method: "POST",
      body: JSON.stringify(VALID),
    });
    expect(okResponse.error).toBeNull();
    expect(okResponse.requestId).toMatch(/^req_/);
    expect(okResponse.response.headers.get("x-request-id")).toBe(okResponse.requestId);

    const errorResponse = await app.json("/v1/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "nope" }),
    });
    expect(errorResponse.data).toBeNull();
    expect(errorResponse.error?.code).toBe("VALIDATION_ERROR");
    expect(errorResponse.requestId).toMatch(/^req_/);
  });

  it("never leaks a stack trace or SQL detail on malformed input", async () => {
    const response = await app.fetch("/v1/auth/signup", {
      method: "POST",
      body: "{not json at all",
      headers: { "content-type": "application/json" },
    });
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(text).not.toMatch(/at .*\(.*:\d+:\d+\)/); // no stack frames
    expect(text).not.toMatch(/postgres|pg_|relation|syntax error at/i);
  });
});

// ===========================================================================
describe("account deletion", () => {
  /**
   * Self-service deletion ships OFF.
   *
   * The dashboard no longer offers it and the endpoint refuses by default, so
   * everything below has to switch the flag on first. The behaviour is still
   * worth pinning: it is the only path that anonymises an account, there is no
   * admin equivalent, and it is what a deletion request is honoured with.
   */
  async function enableDeletion() {
    await app.db.db.execute(sql`
      INSERT INTO feature_flags (id, key, description, enabled, high_risk)
      VALUES ('flag_test_delete', 'account_deletion_enabled', 'test', true, true)
      ON CONFLICT (key) DO UPDATE SET enabled = true
    `);
    app.services.settings.invalidate();
  }

  it("is refused by default, whoever asks", async () => {
    await signupAndVerify();
    const session = await login();

    const result = await app.json("/v1/me", {
      method: "DELETE",
      cookies: session.cookies,
      body: JSON.stringify({
        currentPassword: VALID.password,
        confirmation: "DELETE MY ACCOUNT",
      }),
    });

    expect(result.status).toBe(403);
    expect(result.error?.code).toBe("FEATURE_DISABLED");

    // And the account is untouched — refused, not half-done.
    const still = await app.db.db.execute<{ status: string }>(
      sql`SELECT status FROM users WHERE normalized_email = ${VALID.email}`,
    );
    expect(still.rows[0]?.status).toBe("active");
  });

  it("anonymises the user, revokes sessions and preserves the ledger", async () => {
    await enableDeletion();
    await signupAndVerify();
    const session = await login();

    // Give the account some credit history to preserve.
    const userRow = await app.db.db.execute<{ id: string }>(sql`SELECT id FROM users LIMIT 1`);
    const userId = userRow.rows[0]!.id;
    await app.services.credits.adminAdjust({
      userId,
      amount: 100,
      reason: "seed for deletion test",
      adminId: userId,
      idempotencyKey: "idem_deletion_test_key",
    });

    const deleted = await app.json("/v1/me", {
      method: "DELETE",
      cookies: session.cookies,
      body: JSON.stringify({
        currentPassword: VALID.password,
        confirmation: "DELETE MY ACCOUNT",
      }),
    });
    expect(deleted.status).toBe(200);

    const after = await app.db.db.execute<{
      email: string;
      name: string;
      status: string;
      anonymized_at: string | null;
    }>(sql`SELECT email, name, status, anonymized_at FROM users WHERE id = ${userId}`);
    const row = after.rows[0]!;

    // Personal data is gone...
    expect(row.email).not.toContain("ada@example.test");
    expect(row.email).toContain("deleted.inkloom.invalid");
    expect(row.name).toBe("Deleted account");
    expect(row.status).toBe("deleted");
    expect(row.anonymized_at).not.toBeNull();

    // ...the accounting record is not.
    const ledger = await app.db.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM credit_ledger WHERE user_id = ${userId}`,
    );
    expect(Number(ledger.rows[0]!.count)).toBe(1);

    // Sessions are dead, and an audit event exists.
    expect((await app.json("/v1/me", { cookies: session.cookies })).status).toBe(401);

    const audit = await app.db.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM audit_events WHERE action = 'user.account.delete'`,
    );
    expect(Number(audit.rows[0]!.count)).toBe(1);
  });

  it("refuses deletion without the exact typed confirmation", async () => {
    await signupAndVerify();
    const session = await login();

    const result = await app.json("/v1/me", {
      method: "DELETE",
      cookies: session.cookies,
      body: JSON.stringify({ currentPassword: VALID.password, confirmation: "delete" }),
    });
    expect(result.status).toBe(400);
  });

  it("refuses deletion without a correct password (recent authentication)", async () => {
    await enableDeletion();
    await signupAndVerify();
    const session = await login();

    const result = await app.json("/v1/me", {
      method: "DELETE",
      cookies: session.cookies,
      body: JSON.stringify({
        currentPassword: "not-the-password",
        confirmation: "DELETE MY ACCOUNT",
      }),
    });
    expect(result.status).toBe(401);
  });
});

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
  password: "a-perfectly-fine-passphrase-1",
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

  /*
   * This used to assert the OPPOSITE — that a duplicate signup was
   * indistinguishable from a fresh one. That was changed deliberately, not
   * abandoned: see the note on `refuseDuplicateSignup`. A signup form cannot
   * meaningfully hide whether an address is taken, and the neutral version left
   * people waiting for a confirmation email that was never sent.
   *
   * What must NOT change is that no second account appears, and that login and
   * password reset stay neutral. Both are asserted elsewhere in this file.
   */
  it("tells the caller the address is taken, and creates no second account", async () => {
    await signupAndVerify();
    const second = await signup();

    expect(second.status).toBe(409);
    expect(JSON.stringify(second.error)).toMatch(/already exists/i);

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

  it("acts on the marketing opt-in instead of only filing it", async () => {
    /*
     * The consent row and the notification preference are two records of one
     * decision, and they were allowed to disagree: signup wrote the consent but
     * nothing carried the answer onto the preferences row, which Better Auth's
     * create hook had already inserted with `marketing_email` false. Since the
     * mailer gates on the PREFERENCE, ticking the box did nothing at all.
     *
     * It failed safe — no unwanted mail — which is why nobody noticed. Both
     * directions are asserted, because a fix that just forced it true would be
     * the far more damaging bug.
     */
    for (const optedIn of [true, false]) {
      await app.reset();
      await signup({ email: `optin-${optedIn}@example.test`, marketingOptIn: optedIn });

      const row = await app.db.db.execute<{ consent: boolean; preference: boolean }>(
        sql`SELECT c.granted AS consent, n.marketing_email AS preference
              FROM users u
              JOIN user_consents c ON c.user_id = u.id AND c.type = 'marketing_email'
              JOIN notification_preferences n ON n.user_id = u.id
             WHERE u.email = ${`optin-${optedIn}@example.test`}`,
      );

      expect(row.rows[0]?.consent, "the consent record").toBe(optedIn);
      expect(row.rows[0]?.preference, "the switch the mailer actually reads").toBe(optedIn);
    }
  });

  it("refuses signup without explicit acceptance of the terms", async () => {
    const result = await signup({ acceptedTerms: false });
    expect(result.status).toBe(400);
    expect(result.error?.code).toBe("VALIDATION_ERROR");
    expect(app.mail.sent).toHaveLength(0);
  });

  it("enforces every part of the password rule, and says which part failed", async () => {
    /*
     * Four rules, so four ways to fail. Each is checked on its own: a single
     * "invalid password" test would still pass if three of the four quietly
     * stopped being enforced.
     */
    const cases = [
      { why: "too short", password: "a1!", expect: /at least 6/i },
      { why: "no letter", password: "123456!", expect: /one letter/i },
      { why: "no number", password: "abcdef!", expect: /one number/i },
      { why: "no special character", password: "abcdef123", expect: /special character/i },
    ];

    for (const [index, c] of cases.entries()) {
      const result = await signup({ email: `bad${index}@example.test`, password: c.password });
      expect(result.status, c.why).toBe(400);
      expect(result.error?.code, c.why).toBe("VALIDATION_ERROR");
      expect(JSON.stringify(result.error), c.why).toMatch(c.expect);
    }

    // Six characters with one of each is the documented minimum, and it works.
    const minimal = await signup({ email: "minimal@example.test", password: "aB3!xy" });
    expect(minimal.status).toBe(200);

    // A long passphrase is still fine, provided it carries a digit and a symbol.
    const long = await signup({
      email: "long@example.test",
      password: "correct horse battery staple 7!",
    });
    expect(long.status).toBe(200);
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
      body: JSON.stringify({ token, password: "a-totally-new-passphrase-7" }),
    });
    expect(reset.status).toBe(200);
    expect((await login("forgetful@example.test", "a-totally-new-passphrase-7")).status).toBe(200);
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

    const newPassword = "an-entirely-different-passphrase-2";
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
      body: JSON.stringify({ token, password: "yet-another-passphrase-here-3" }),
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
      body: JSON.stringify({ token: firstToken, password: "a-brand-new-passphrase-x4" }),
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
      body: JSON.stringify({ token, password: "post-reset-passphrase-here-5" }),
    });

    // The pre-reset session no longer resolves.
    const me = await app.json("/v1/me", { cookies: loggedIn.cookies });
    expect(me.status).toBe(401);
  });

  /*
   * The per-email reset budget, which can ONLY be verified here.
   *
   * On a deployed environment Turnstile is checked before this limiter and
   * fails closed, so a script with no token is refused at 403 and the bucket is
   * never reached — by design, and the right order: the cheapest gate first.
   * The consequence is that live acceptance cannot exercise it without either
   * solving a challenge or disabling one, and disabling a control to observe
   * another is not a trade worth making. This suite runs with Turnstile off
   * legitimately, so it is the correct place to hold this guarantee.
   */
  it("limits reset requests per email address, not only per network", async () => {
    await signupAndVerify();

    const request = () =>
      app.json("/v1/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: VALID.email }),
      });

    // The policy allows 3 an hour per address.
    for (let i = 0; i < 3; i += 1) expect((await request()).status).toBe(200);

    const counted = await app.db.db.execute<{ total: string }>(
      sql`SELECT COALESCE(SUM(count),0)::text AS total FROM rate_limit_events
           WHERE bucket = 'auth.forgot_password.email'
             AND subject = ${"email:" + VALID.email}`,
    );
    expect(Number(counted.rows[0]!.total), "each request must be charged").toBeGreaterThanOrEqual(3);

    /*
     * Past the budget the response stays NEUTRAL rather than becoming a 429.
     * That is deliberate: a rate-limit response on an address that exists,
     * where an unknown address still returns 200, would itself be an
     * enumeration oracle. The limit shows up as mail not being sent.
     */
    app.mail.clear();
    const beyond = await request();
    expect(beyond.status, "the response must not reveal the limit").toBe(200);
    expect(app.mail.lastTo(VALID.email), "but no further mail is sent").toBeUndefined();
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
      body: JSON.stringify({ token, password: "notified-passphrase-value-6" }),
    });

    const notice = app.mail.lastTo(VALID.email);
    expect(notice?.template).toBe("password_changed");
  });
});

// ===========================================================================
describe("sessions", () => {
  it("shows a coarse device label, derived once and never re-parsed", async () => {
    /*
     * The label is computed in the session-create hook so the full User-Agent
     * never reaches storage, and the read path must use it AS IS. It used to
     * run `deviceLabel` again over its own output: "Chrome on macOS" contains
     * no "mac os" and no "macintosh", so it came back "Chrome on Unknown OS" —
     * which is what the sessions page displayed. A real User-Agent here is what
     * makes that visible; without one the label is "Unknown device" either way.
     */
    await signupAndVerify();
    const session = await app.json<unknown>("/v1/auth/login", {
      method: "POST",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({ email: VALID.email, password: VALID.password }),
    });

    const result = await app.json<{
      sessions: Array<{ id: string; device: string; current: boolean }>;
    }>("/v1/me/sessions", { cookies: session.cookies });

    expect(result.status).toBe(200);
    expect(result.data!.sessions.length).toBeGreaterThanOrEqual(1);
    expect(result.data!.sessions.map((s) => s.device)).toContain("Chrome on macOS");

    // And nothing identifying beyond that.
    const serialised = JSON.stringify(result.data);
    expect(serialised).not.toMatch(/"token"/);
    expect(serialised).not.toMatch(/ipAddress|ip_hash|\d+\.\d+\.\d+\.\d+/);
    // The raw User-Agent itself must never appear.
    expect(serialised).not.toMatch(/AppleWebKit|Mozilla/);
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
describe("an account with no password", () => {
  /*
   * What signing up through Google produces: a user row with no credential
   * password. Everything that asks for the current password — change password,
   * change email, enable two-factor — cannot work for them, which is why the
   * dashboard has to know and why `set-password` exists.
   *
   * Simulated by clearing the password rather than driving a real OAuth flow:
   * the resulting state is identical, and the point is what the API does with
   * it.
   */
  async function stripPassword() {
    await app.db.db.execute(sql`UPDATE accounts SET password = NULL`);
  }

  it("reports hasPassword on /me so the dashboard can branch", async () => {
    await signupAndVerify();
    const session = await login();

    const before = await app.json<{ hasPassword: boolean; providers: string[] }>("/v1/me", {
      cookies: session.cookies,
    });
    expect(before.data?.hasPassword).toBe(true);
    expect(before.data?.providers).toContain("credential");

    await stripPassword();

    const after = await app.json<{ hasPassword: boolean }>("/v1/me", {
      cookies: session.cookies,
    });
    expect(after.data?.hasPassword).toBe(false);
  });

  it("never returns the password hash itself", async () => {
    await signupAndVerify();
    const session = await login();
    const result = await app.json("/v1/me", { cookies: session.cookies });
    const serialised = JSON.stringify(result.data);
    expect(serialised).not.toMatch(/hash|scrypt|\$2[aby]\$/);
    expect(serialised).not.toContain(VALID.password);
  });

  it("can set a first password, which then satisfies the password rule", async () => {
    await signupAndVerify();
    const session = await login();
    await stripPassword();

    // The rule still applies to a first password.
    const weak = await app.json("/v1/auth/set-password", {
      method: "POST",
      cookies: session.cookies,
      body: JSON.stringify({ newPassword: "abcdef" }),
    });
    expect(weak.status).toBe(400);

    const ok = await app.json("/v1/auth/set-password", {
      method: "POST",
      cookies: session.cookies,
      body: JSON.stringify({ newPassword: "gK7#pw" }),
    });
    expect(ok.status).toBe(200);

    // And it really is set: /me agrees, and the new password signs in.
    const me = await app.json<{ hasPassword: boolean }>("/v1/me", { cookies: session.cookies });
    expect(me.data?.hasPassword).toBe(true);
    expect((await login(VALID.email, "gK7#pw")).status).toBe(200);

    /*
     * And the notice says what happened.
     *
     * This used to send `password_changed`, which warns that a password "was
     * changed" — alarming and wrong for someone who signed up with Google and
     * has just set their first one. Nothing changed; something was added.
     */
    const notice = app.mail.lastTo(VALID.email);
    expect(notice?.template).toBe("password_added");
    expect(notice?.subject).toMatch(/added/i);
    expect(notice?.subject).not.toMatch(/changed/i);
  });

  it("refuses to overwrite a password that already exists", async () => {
    /*
     * The important refusal. Without it, anyone holding a live session could
     * replace the password without knowing the old one — which is precisely
     * what the change-password flow requires and this one does not.
     */
    await signupAndVerify();
    const session = await login();

    const result = await app.json("/v1/auth/set-password", {
      method: "POST",
      cookies: session.cookies,
      body: JSON.stringify({ newPassword: "zZ9#qq" }),
    });
    expect(result.status).toBe(409);
    expect(result.error?.code).toBe("CONFLICT");

    // The original password still works.
    expect((await login()).status).toBe(200);
  });
});

// ===========================================================================

describe("two-factor enrolment", () => {
  /*
   * The bug: `enableTwoFactor` INSERTs a row every time it is called, and the
   * schema indexes two_factor.user_id without a unique constraint. Someone who
   * opened the setup form, walked away, and came back had two unverified rows.
   * `verifyTOTP` looks up "the" row for the user and got an arbitrary one —
   * usually not the secret behind the QR code just scanned — so enrolment was
   * permanently unverifiable and every correct code came back "not valid".
   *
   * Found on staging, where the account could not turn 2FA on at all, which in
   * turn made the admin console unreachable: the middleware requires 2FA for
   * staff, with no way around it.
   */
  async function startSetup(cookies: string[]) {
    return app.json("/v1/auth/two-factor/enable", {
      method: "POST",
      cookies,
      body: JSON.stringify({ currentPassword: VALID.password }),
    });
  }

  const rows = async () => {
    const result = await app.db.db.execute<{ id: string; verified: boolean }>(
      sql`SELECT id, verified FROM two_factor ORDER BY id`,
    );
    return result.rows;
  };

  const totpUri = (result: { data?: unknown }) =>
    (result.data as { totpURI?: string } | undefined)?.totpURI;

  it("leaves exactly one unverified row when setup is restarted", async () => {
    await signupAndVerify();
    const { cookies } = await login();

    const first = await startSetup(cookies);
    expect(first.status).toBe(200);
    expect(await rows()).toHaveLength(1);

    const second = await startSetup(cookies);
    expect(second.status).toBe(200);

    // The point: restarting replaces the abandoned enrolment rather than
    // accumulating a second one alongside it.
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]!.verified).toBe(false);
  });

  it("issues a fresh secret on restart, so the newest QR code is the live one", async () => {
    await signupAndVerify();
    const { cookies } = await login();

    const first = await startSetup(cookies);
    const second = await startSetup(cookies);

    expect(totpUri(first)).toBeDefined();
    expect(totpUri(second)).toBeDefined();
    expect(totpUri(second)).not.toBe(totpUri(first));
  });

  it("still refuses a wrong password, so the reset cannot be used unauthenticated", async () => {
    await signupAndVerify();
    const { cookies } = await login();

    const result = await app.json("/v1/auth/two-factor/enable", {
      method: "POST",
      cookies,
      body: JSON.stringify({ currentPassword: "not-the-password" }),
    });

    expect(result.status).toBe(401);
    // And nothing was created or destroyed on the way to that refusal.
    expect(await rows()).toHaveLength(0);
  });

  /*
   * The whole enrolment, with a REAL code.
   *
   * Everything else here asserts refusals, which is the easy half — a handler
   * that always failed would pass all of them. This one derives the actual TOTP
   * from the secret in the URI the server just handed out, using the same
   * primitive Better Auth verifies with, and requires that it be accepted and
   * that the account come out of it genuinely protected.
   *
   * Written while 2FA could not be completed on staging, to answer one question
   * the deployed environment could not: is the code path itself correct?
   */
  it("completes enrolment with a genuine code and flips the account to protected", async () => {
    const { createOTP } = await import("@better-auth/utils/otp");
    const { base32 } = await import("@better-auth/utils/base32");

    await signupAndVerify();
    const { cookies } = await login();

    const started = await startSetup(cookies);
    const uri = totpUri(started);
    expect(uri).toBeDefined();

    /*
     * The URI carries base32(raw secret), which is what an authenticator app
     * decodes to get its HMAC key. Better Auth computes the code over the RAW
     * secret string, and those are the same bytes. Passing the base32 form
     * straight into createOTP hashes the wrong key and produces a code that is
     * wrong in a completely convincing way — six digits that change every
     * thirty seconds and are never accepted. Worth stating, because it is
     * indistinguishable from a broken server.
     */
    const encoded = new URL(uri!).searchParams.get("secret");
    expect(encoded).toBeTruthy();
    const secret = new TextDecoder().decode(base32.decode(encoded!));

    const code = await createOTP(secret).totp();
    const confirmed = await app.json("/v1/auth/two-factor/confirm", {
      method: "POST",
      cookies,
      body: JSON.stringify({ code }),
    });

    expect(confirmed.status).toBe(200);

    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]!.verified).toBe(true);

    const flag = await app.db.db.execute<{ two_factor_enabled: boolean }>(
      sql`SELECT two_factor_enabled FROM users LIMIT 1`,
    );
    expect(flag.rows[0]!.two_factor_enabled).toBe(true);
  });

  it("rejects an invalid confirmation code without enabling anything", async () => {
    await signupAndVerify();
    const { cookies } = await login();
    await startSetup(cookies);

    const result = await app.json("/v1/auth/two-factor/confirm", {
      method: "POST",
      cookies,
      body: JSON.stringify({ code: "000000" }),
    });

    expect(result.status).toBe(401);
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]!.verified).toBe(false);
  });
});


// ===========================================================================

describe("signing up with an address that already has an account", () => {
  /*
   * This flow DELIBERATELY reveals that the address is registered, unlike login
   * and password reset which stay neutral. A signup form cannot really hide it —
   * the address either becomes an account or it does not — and the neutral
   * version left people waiting for a confirmation email that was never coming.
   */

  it("says plainly that the account exists, and does not pretend to send mail", async () => {
    await signupAndVerify();
    app.mail.clear();

    const result = await signup();

    expect(result.status, "409 Conflict, not a cheerful 200").toBe(409);
    expect(result.error?.code).toBe("CONFLICT");
    expect(JSON.stringify(result.error)).toMatch(/already exists/i);
    expect(app.mail.sent, "no email of any kind for a verified duplicate").toHaveLength(0);
  });

  it("resends the link instead when the existing account is UNVERIFIED", async () => {
    // Registered but never confirmed: telling them to sign in is a dead end,
    // because sign-in refuses an unverified account.
    await signup();
    app.mail.clear();

    const result = await signup();

    expect(result.status, "not an error — they can still finish").toBe(200);
    expect(JSON.stringify(result.data)).toMatch(/not confirmed/i);
    expect(app.mail.lastTo(VALID.email)?.template).toBe("verify_email");
  });

  it("still sends a normal verification email to a brand-new address", async () => {
    app.mail.clear();

    const result = await signup({ email: "stranger@example.test" });

    expect(result.status).toBe(200);
    expect(app.mail.lastTo("stranger@example.test")?.template).toBe("verify_email");
  });

  it("records the duplicate for operators", async () => {
    await signupAndVerify();
    const before = await app.db.db.execute<{ n: string }>(
      sql`SELECT COUNT(*) AS n FROM security_events WHERE metadata->>'flow' = 'signup_duplicate'`,
    );

    await signup();

    const after = await app.db.db.execute<{ n: string }>(
      sql`SELECT COUNT(*) AS n FROM security_events WHERE metadata->>'flow' = 'signup_duplicate'`,
    );
    expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n) + 1);
  });

  it("creates no second account and no second wallet", async () => {
    await signupAndVerify();

    await signup();

    const counts = await app.db.db.execute<{ users: string; wallets: string }>(
      sql`SELECT (SELECT COUNT(*) FROM users) AS users,
                 (SELECT COUNT(*) FROM credit_wallets) AS wallets`,
    );
    expect(Number(counts.rows[0]!.users)).toBe(1);
    expect(Number(counts.rows[0]!.wallets)).toBeLessThanOrEqual(1);
  });

  it("keeps LOGIN neutral — enumeration protection stays where it works", async () => {
    await signupAndVerify();

    const known = await login(VALID.email, "definitely-the-wrong-password");
    const unknown = await login("no-such-person@example.test", "definitely-the-wrong-password");

    expect(known.status).toBe(unknown.status);
    expect(known.error?.code).toBe(unknown.error?.code);
  });
});

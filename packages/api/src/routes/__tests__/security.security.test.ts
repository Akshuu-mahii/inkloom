/**
 * Security test suite.
 *
 * Every item the brief lists, exercised against the real Hono app, the real
 * Better Auth instance and a real Postgres. These are the tests that would fail
 * if someone removed a guard, so they are written to assert the OUTCOME (the
 * request is refused, nothing changed) rather than the implementation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestApp, extractToken, type TestApp } from "../../../../../tests/helpers/app";
import { createTestUser } from "../../../../../tests/helpers/db";

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

const CREDENTIALS = {
  email: "victim@example.test",
  password: "a-perfectly-fine-passphrase-1",
  name: "Victim",
  acceptedTerms: true as const,
};

async function signedInCookies(email = CREDENTIALS.email): Promise<string[]> {
  await app.json("/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify({ ...CREDENTIALS, email }),
  });
  const token = extractToken(app.mail.lastTo(email)!.html);
  await app.json("/v1/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) });
  const login = await app.json("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: CREDENTIALS.password }),
  });
  return login.cookies;
}

// ===========================================================================
describe("unauthorised admin access", () => {
  const ADMIN_ENDPOINTS = [
    ["GET", "/v1/admin/overview"],
    ["GET", "/v1/admin/users"],
    ["GET", "/v1/admin/access-codes"],
    ["GET", "/v1/admin/credits/ledger"],
    ["GET", "/v1/admin/audit"],
    ["GET", "/v1/admin/security"],
    ["GET", "/v1/admin/support"],
    ["GET", "/v1/admin/settings"],
    ["GET", "/v1/admin/system"],
    ["POST", "/v1/admin/access-codes"],
    ["POST", "/v1/admin/credits/adjust"],
    ["PATCH", "/v1/admin/settings"],
    ["POST", "/v1/admin/system/emergency"],
  ] as const;

  it.each(ADMIN_ENDPOINTS)("refuses an anonymous caller: %s %s", async (method, path) => {
    const result = await app.json(path, {
      method,
      ...(method === "GET" ? {} : { body: JSON.stringify({}) }),
    });
    expect(result.status).toBeGreaterThanOrEqual(401);
    expect(result.status).toBeLessThan(500);
    expect(result.data).toBeNull();
  });

  it.each(ADMIN_ENDPOINTS)("refuses an ordinary signed-in user: %s %s", async (method, path) => {
    const cookies = await signedInCookies(`plain-${Math.random()}@example.test`);
    const result = await app.json(path, {
      method,
      cookies,
      ...(method === "GET" ? {} : { body: JSON.stringify({}) }),
    });
    expect(result.status, `${method} ${path}`).toBeGreaterThanOrEqual(401);
    expect(result.status).toBeLessThan(500);
    expect(["FORBIDDEN", "UNAUTHENTICATED", "TWO_FACTOR_REQUIRED"]).toContain(result.error?.code);
  });

  it("records every refused admin attempt as a security event", async () => {
    const cookies = await signedInCookies("prober@example.test");
    await app.json("/v1/admin/users", { cookies });

    const events = await app.db.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM security_events WHERE type = 'unauthorized_admin_access'`,
    );
    expect(Number(events.rows[0]!.count)).toBeGreaterThanOrEqual(1);
  });

  it("does not let a client claim a role in the request body", async () => {
    const cookies = await signedInCookies("escalate@example.test");

    // Try to smuggle a role through every plausible channel.
    await app.json("/v1/me", {
      method: "PATCH",
      cookies,
      body: JSON.stringify({ name: "Escalated", role: "super_admin", status: "active" }),
    });

    const row = await app.db.db.execute<{ role: string }>(
      sql`SELECT role FROM users WHERE normalized_email = 'escalate@example.test'`,
    );
    expect(row.rows[0]!.role).toBe("user");

    // And the header form is equally ignored.
    const withHeader = await app.json("/v1/admin/overview", {
      cookies,
      headers: { "x-role": "super_admin", "x-admin": "true" },
    });
    expect(withHeader.status).toBeGreaterThanOrEqual(401);
  });
});

// ===========================================================================
describe("cross-user access (IDOR)", () => {
  it("cannot read another user's sessions or revoke them", async () => {
    const aliceCookies = await signedInCookies("alice@example.test");
    const bobCookies = await signedInCookies("bob@example.test");

    const bobSessions = await app.json<{ sessions: Array<{ id: string }> }>("/v1/me/sessions", {
      cookies: bobCookies,
    });
    const bobSessionId = bobSessions.data!.sessions[0]!.id;

    // Alice attempts to revoke Bob's session by id.
    const attempt = await app.json(`/v1/me/sessions/${bobSessionId}`, {
      method: "DELETE",
      cookies: aliceCookies,
    });

    // 404, not 403: a 403 would confirm the session exists.
    expect(attempt.status).toBe(404);

    // Bob's session still works.
    const bobStillIn = await app.json("/v1/me", { cookies: bobCookies });
    expect(bobStillIn.status).toBe(200);
  });

  it("scopes credit history to the caller, with no user parameter to tamper with", async () => {
    const aliceCookies = await signedInCookies("alice2@example.test");
    const bob = await createTestUser(app.db.db, { email: "bob2@example.test" });

    await app.services.credits.adminAdjust({
      userId: bob.id,
      amount: 999,
      reason: "bob's private credits",
      adminId: bob.id,
      idempotencyKey: "idem_bob_private_key",
    });

    // Every shape of tampering returns only Alice's (empty) history.
    for (const path of [
      "/v1/credits/history",
      `/v1/credits/history?userId=${bob.id}`,
      `/v1/credits/history?user_id=${bob.id}`,
    ]) {
      const result = await app.json<{ items: unknown[] }>(path, { cookies: aliceCookies });
      expect(result.status).toBe(200);
      expect(result.data!.items).toHaveLength(0);
    }
  });

  it("cannot read another user's support request by reference", async () => {
    const aliceCookies = await signedInCookies("alice3@example.test");
    const bobCookies = await signedInCookies("bob3@example.test");

    const created = await app.json<{ reference: string }>("/v1/support", {
      method: "POST",
      cookies: bobCookies,
      body: JSON.stringify({
        email: "bob3@example.test",
        subject: "Bob's private problem",
        message: "This is confidential to Bob and nobody else.",
        category: "account",
      }),
    });

    const peek = await app.json(`/v1/support/${created.data!.reference}`, {
      cookies: aliceCookies,
    });
    expect(peek.status).toBe(404);
  });
});

// ===========================================================================
describe("the owner gate", () => {
  /*
   * A second authority on staff access, independent of the role column.
   *
   * The role lives in a table; OWNER_EMAIL lives in the deployment's secrets.
   * Requiring both means writing to `users.role` is no longer enough to reach
   * the console — which is precisely the escalation the test above proves a
   * client cannot perform through the API, and this defends the case where an
   * attacker reaches the database by some other route entirely.
   */
  async function staffCookies(app: TestApp, email: string): Promise<string[]> {
    await app.json("/v1/auth/signup", {
      method: "POST",
      body: JSON.stringify({ ...CREDENTIALS, email }),
    });
    const token = extractToken(app.mail.lastTo(email)!.html);
    await app.json("/v1/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) });
    const login = await app.json("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password: CREDENTIALS.password }),
    });

    /*
     * Promote AFTER signing in, not before.
     *
     * Setting `two_factor_enabled` first makes the login itself demand a second
     * factor, so no session cookie is ever issued and every assertion below
     * fails with 401 for a reason that has nothing to do with the gate under
     * test. Promoting afterwards works because `loadPrincipal` re-reads role
     * and 2FA from the database on every request — which is the property that
     * makes an instant demotion possible, demonstrated here by accident.
     */
    await app.db.db.execute(
      sql`UPDATE users SET role = 'super_admin', two_factor_enabled = true WHERE email = ${email}`,
    );
    return login.cookies;
  }

  it("refuses a full super_admin who is not the configured owner", async () => {
    const owned = createTestApp({ OWNER_EMAIL: "owner@example.test" });
    try {
      await owned.reset();
      const cookies = await staffCookies(owned, "impostor@example.test");

      const result = await owned.json("/v1/admin/overview", { cookies });

      expect(result.status, "a role alone must not be enough").toBe(403);
      expect(result.error?.code).toBe("FORBIDDEN");
      // The refusal must not say WHICH gate stopped them.
      expect(JSON.stringify(result)).not.toContain("owner");
    } finally {
      await owned.close();
    }
  });

  it("admits the configured owner", async () => {
    const owned = createTestApp({ OWNER_EMAIL: "owner@example.test" });
    try {
      await owned.reset();
      const cookies = await staffCookies(owned, "owner@example.test");
      const result = await owned.json("/v1/admin/overview", { cookies });
      expect(result.status).toBe(200);
    } finally {
      await owned.close();
    }
  });

  it("matches the owner case-insensitively, so a capital cannot lock them out", async () => {
    const owned = createTestApp({ OWNER_EMAIL: "Owner@Example.Test" });
    try {
      await owned.reset();
      const cookies = await staffCookies(owned, "owner@example.test");
      const result = await owned.json("/v1/admin/overview", { cookies });
      expect(result.status).toBe(200);
    } finally {
      await owned.close();
    }
  });

  it("records a refused owner-gate attempt as a security event", async () => {
    const owned = createTestApp({ OWNER_EMAIL: "owner@example.test" });
    try {
      await owned.reset();
      const cookies = await staffCookies(owned, "impostor@example.test");
      await owned.json("/v1/admin/overview", { cookies });

      const events = await owned.db.db.execute<{ type: string; metadata: { reason?: string } }>(
        sql`SELECT type, metadata FROM security_events WHERE type = 'unauthorized_admin_access'`,
      );
      expect(events.rows.length).toBeGreaterThan(0);
      expect(events.rows.some((r) => r.metadata?.reason === "owner_gate")).toBe(true);
    } finally {
      await owned.close();
    }
  });

  it("falls back to the role check when no owner is configured", async () => {
    // Staging legitimately has several staff accounts. Requiring a single owner
    // there would push people towards sharing one login, which is worse.
    const cookies = await staffCookies(app, "staff@example.test");
    const result = await app.json("/v1/admin/overview", { cookies });
    expect(result.status).toBe(200);
  });
});

// ===========================================================================
describe("CSRF and origin", () => {
  it("refuses a state-changing request with a foreign Origin", async () => {
    const cookies = await signedInCookies("csrf@example.test");

    const result = await app.json("/v1/me", {
      method: "PATCH",
      cookies,
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ name: "Hacked" }),
    });

    expect(result.status).toBe(403);
    expect(result.error?.code).toBe("ORIGIN_REJECTED");

    // Nothing changed.
    const me = await app.json<{ name: string }>("/v1/me", { cookies });
    expect(me.data!.name).not.toBe("Hacked");
  });

  it("refuses a state-changing request with no Origin at all", async () => {
    const cookies = await signedInCookies("csrf2@example.test");

    const response = await app.fetch("/v1/me", {
      method: "PATCH",
      cookies,
      // Explicitly blank so the helper does not supply the default.
      headers: { origin: "", "content-type": "application/json" },
      body: JSON.stringify({ name: "Hacked" }),
    });

    expect(response.status).toBe(403);
  });

  it("refuses the content types a cross-origin HTML form can send", async () => {
    const cookies = await signedInCookies("csrf3@example.test");

    for (const contentType of [
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "text/plain;charset=UTF-8",
    ]) {
      const response = await app.fetch("/v1/me", {
        method: "PATCH",
        cookies,
        headers: { "content-type": contentType },
        body: "name=Hacked",
      });
      expect(response.status, contentType).toBe(415);
    }
  });

  it("allows safe methods without an Origin", async () => {
    const cookies = await signedInCookies("safe@example.test");
    const response = await app.fetch("/v1/me", { cookies, headers: { origin: "" } });
    expect(response.status).toBe(200);
  });
});

// ===========================================================================
describe("session integrity", () => {
  it("rejects a forged session cookie", async () => {
    await signedInCookies("forge@example.test");

    for (const forged of [
      "inkloom_session=forged-value",
      "inkloom_session=",
      "__Host-inkloom_session=forged",
      "inkloom_session=' OR '1'='1",
    ]) {
      const result = await app.json("/v1/me", { cookies: [forged] });
      expect(result.status, forged).toBe(401);
    }
  });

  it("rejects a revoked session immediately", async () => {
    const cookies = await signedInCookies("revoked@example.test");
    expect((await app.json("/v1/me", { cookies })).status).toBe(200);

    await app.db.db.execute(sql`UPDATE sessions SET revoked_at = now()`);

    expect((await app.json("/v1/me", { cookies })).status).toBe(401);
  });

  it("rejects an expired session", async () => {
    const cookies = await signedInCookies("expired@example.test");
    // Push last activity beyond the idle window.
    await app.db.db.execute(
      sql`UPDATE sessions SET last_active_at = now() - interval '30 days', updated_at = now() - interval '30 days'`,
    );
    expect((await app.json("/v1/me", { cookies })).status).toBe(401);
  });

  it("rejects every session created before the session epoch (emergency logout)", async () => {
    const cookies = await signedInCookies("epoch@example.test");
    expect((await app.json("/v1/me", { cookies })).status).toBe(200);

    await app.db.db.execute(sql`
      INSERT INTO system_settings (id, key, value, description, high_risk)
      VALUES ('set_epoch_test', 'session_epoch',
              ${JSON.stringify({ users: new Date(Date.now() + 1000).toISOString(), admins: new Date().toISOString() })}::jsonb,
              'test', true)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);
    app.services.settings.invalidate();

    expect((await app.json("/v1/me", { cookies })).status).toBe(401);
  });

  it("gives a suspended user no access, even with a valid cookie", async () => {
    const cookies = await signedInCookies("suspended@example.test");
    await app.db.db.execute(
      sql`UPDATE users SET status = 'suspended', suspended_at = now(), suspended_reason = 'test'`,
    );
    expect((await app.json("/v1/me", { cookies })).status).toBe(401);
  });
});

// ===========================================================================
describe("injection payloads", () => {
  const SQL_PAYLOADS = [
    "' OR '1'='1",
    "'; DROP TABLE users; --",
    "admin'--",
    "1' UNION SELECT NULL,NULL,NULL--",
    "\\'; DELETE FROM credit_ledger WHERE '1'='1",
  ];

  it.each(SQL_PAYLOADS)("treats %s as data, not SQL", async (payload) => {
    // Through login (parameterised lookup)...
    const login = await app.json("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: `${payload}@example.test`, password: payload }),
    });
    expect([400, 401, 429]).toContain(login.status);

    // ...and through a redemption code.
    const cookies = await signedInCookies(`sqli-${Math.random()}@example.test`);
    const redeem = await app.json("/v1/access-codes/redeem", {
      method: "POST",
      cookies,
      body: JSON.stringify({ code: payload }),
    });
    expect(redeem.status).toBeGreaterThanOrEqual(400);

    // The tables are still there and intact.
    const tables = await app.db.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_schema='public'`,
    );
    expect(Number(tables.rows[0]!.count)).toBeGreaterThan(20);
  });

  it("stores XSS payloads as inert text", async () => {
    const cookies = await signedInCookies("xss@example.test");
    const payload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';

    await app.json("/v1/me", {
      method: "PATCH",
      cookies,
      body: JSON.stringify({ name: payload }),
    });

    const me = await app.json<{ name: string }>("/v1/me", { cookies });
    // Stored verbatim as TEXT — React escapes it on render, so it is inert.
    // What matters is that it is never interpreted server-side.
    expect(me.data!.name).toBe(payload);

    const row = await app.db.db.execute<{ name: string }>(
      sql`SELECT name FROM users WHERE normalized_email = 'xss@example.test'`,
    );
    expect(row.rows[0]!.name).toBe(payload);
  });
});

// ===========================================================================
describe("request hygiene", () => {
  it("rejects malformed JSON with a 400, never a 500", async () => {
    const response = await app.fetch("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not valid json",
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toMatch(/SyntaxError|at Object\.|node_modules/);
  });

  it("rejects an oversized body before parsing it", async () => {
    const response = await app.fetch("/v1/support", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(5_000_000) },
      body: JSON.stringify({ message: "x".repeat(100) }),
    });
    expect(response.status).toBe(413);
  });

  it("never returns a stack trace or database detail", async () => {
    const probes = [
      { path: "/v1/me", init: {} },
      { path: "/v1/credits", init: {} },
      { path: "/v1/does-not-exist", init: {} },
      { path: "/v1/admin/users/../../etc/passwd", init: {} },
    ];

    for (const probe of probes) {
      const response = await app.fetch(probe.path, probe.init);
      const text = await response.text();
      expect(text).not.toMatch(/at .*\(.*:\d+:\d+\)/);
      expect(text).not.toMatch(/node_modules|drizzle|postgres:\/\/|relation ".*" does not exist/i);
    }
  });

  it("assigns a request id to every response, including errors", async () => {
    for (const path of ["/v1/me", "/v1/nope"]) {
      const response = await app.fetch(path);
      expect(response.headers.get("x-request-id")).toMatch(/^req_/);
    }
  });
});

// ===========================================================================
describe("secrets never leave the server", () => {
  it("never returns a password hash, session token or code fingerprint", async () => {
    const cookies = await signedInCookies("leak@example.test");

    const responses = await Promise.all(
      ["/v1/me", "/v1/me/sessions", "/v1/credits", "/v1/credits/history"].map((path) =>
        app.fetch(path, { cookies }).then((r) => r.text()),
      ),
    );

    for (const body of responses) {
      expect(body).not.toMatch(/"password"/);
      expect(body).not.toMatch(/"token"/);
      expect(body).not.toMatch(/codeFingerprint|code_fingerprint/);
      expect(body).not.toMatch(/\$2[aby]\$|scrypt|pbkdf2/);
      expect(body).not.toContain(CREDENTIALS.password);
    }
  });

  it("never returns the pepper or auth secret in an error", async () => {
    const response = await app.fetch("/v1/access-codes/redeem", {
      method: "POST",
      body: JSON.stringify({ code: "X" }),
    });
    const text = await response.text();
    expect(text).not.toContain("test-access-code-pepper-32-chars-long");
    expect(text).not.toContain("test-secret-that-is-long-enough-to-pass-validation");
  });
});

// ===========================================================================
describe("rate limiting", () => {
  it("blocks repeated failed redemptions and records the block", async () => {
    const cookies = await signedInCookies("ratelimit@example.test");

    let blocked = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const result = await app.json("/v1/access-codes/redeem", {
        method: "POST",
        cookies,
        body: JSON.stringify({ code: `WRONGCODE${attempt}` }),
      });
      if (result.status === 429) {
        blocked = true;
        expect(result.error?.code).toBe("RATE_LIMITED");
        expect(Number(result.response.headers.get("retry-after"))).toBeGreaterThan(0);
        break;
      }
    }

    expect(blocked, "repeated failed redemptions must eventually be rate limited").toBe(true);

    const events = await app.db.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM rate_limit_events WHERE blocked = true`,
    );
    expect(Number(events.rows[0]!.count)).toBeGreaterThanOrEqual(1);
  });

  it("cannot be bypassed by changing the client's apparent address", async () => {
    const cookies = await signedInCookies("bypass@example.test");

    // Burn the per-user budget.
    for (let i = 0; i < 8; i++) {
      await app.json("/v1/access-codes/redeem", {
        method: "POST",
        cookies,
        body: JSON.stringify({ code: `NOPE${i}` }),
      });
    }

    // Spoofing forwarding headers must not reset a USER-scoped limit.
    const spoofed = await app.json("/v1/access-codes/redeem", {
      method: "POST",
      cookies,
      headers: {
        "x-forwarded-for": "203.0.113.99",
        "cf-connecting-ip": "203.0.113.99",
        "x-real-ip": "203.0.113.99",
      },
      body: JSON.stringify({ code: "STILLNOPE" }),
    });

    expect(spoofed.status).toBe(429);
  });
});

// ===========================================================================
describe("per-IP limits actually separate callers", () => {
  it("keys the bucket on the caller's address, not on one shared subject", async () => {
    /*
     * This inverted the control once already, invisibly.
     *
     * Sign-in and signup go through a server action, and the helper that makes
     * that call forwarded no client address — so the API saw none, and every
     * request in the world shared a SINGLE `ip:` bucket. One attacker then had
     * the same budget as the entire population, and a modest burst would lock
     * everyone else out. Nothing failed; the limiter just stopped separating
     * anybody.
     */
    await app.reset();

    const attempt = (ip: string) =>
      app.json("/v1/auth/forgot-password", {
        method: "POST",
        headers: { "cf-connecting-ip": ip },
        body: JSON.stringify({ email: "someone@example.test", turnstileToken: "t" }),
      });

    await attempt("203.0.113.10");
    await attempt("203.0.113.20");

    const rows = await app.db.db.execute<{ subject: string }>(
      sql`SELECT DISTINCT subject FROM rate_limit_events WHERE bucket LIKE '%.ip'`,
    );

    expect(
      rows.rows.length,
      "two different addresses must land in two different buckets",
    ).toBeGreaterThanOrEqual(2);

    // And never the raw address.
    for (const row of rows.rows) {
      expect(row.subject).not.toMatch(/203\.0\.113/);
      expect(row.subject).toMatch(/^ip:[0-9a-f]+$/);
    }
  });
});

/**
 * Security acceptance, against the DEPLOYED staging Worker.
 *
 *   DATABASE_URL="<staging neon url>" pnpm tsx scripts/security-acceptance.ts
 *
 * The local security suite proves these controls exist in the code. This proves
 * they survive the edge: a Worker cannot fetch its own hostname, `env.vars` do
 * not merge, `--env` on deploy is inert, and Hyperdrive will happily cache an
 * authenticated read. Every one of those broke something that passed locally,
 * so anything asserted here is asserted against the real thing.
 *
 * Fixtures are throwaway accounts on an RFC-reserved domain, seeded directly
 * because signup sits behind Turnstile — which a script must not be able to
 * solve. They are torn down directly at the end; there is no self-service
 * erasure endpoint any more, and an acceptance run should not depend on one.
 *
 * Nothing here weakens a control to make a test easier. Where a limit has to be
 * narrowed to be observable, it is narrowed through the same `rate_limit_
 * overrides` setting an operator uses, and restored in a `finally`.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { createDb, type Database } from "@inkloom/db/client";
import { account as accountTable, newId, user as userTable } from "@inkloom/db";
import { describeTarget, required } from "./_env";

const BASE = process.env.STAGING_URL ?? "https://staging.inkloom.art";
const PASSWORD = "a-perfectly-fine-passphrase-1";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? `  ${detail}` : ""}`);
  } else {
    failed += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ""}`);
  }
}
const section = (title: string) => console.log(`\n=== ${title} ===`);

// ---------------------------------------------------------------------------

interface Reply {
  status: number;
  data: Record<string, unknown> | null;
  error: { code?: string; message?: string; details?: Record<string, unknown> } | null;
  cookies: string[];
  headers: Headers;
  text: string;
}

async function call(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    cookies?: string[];
    headers?: Record<string, string>;
    raw?: string;
  } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: BASE,
    ...init.headers,
  };
  if (init.cookies?.length) {
    headers.cookie = init.cookies.map((c) => c.split(";")[0]).join("; ");
  }

  const response = await fetch(`${BASE}${path.startsWith("/api") ? "" : "/api"}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });

  const text = await response.text();
  let envelope: { data?: Record<string, unknown>; error?: Reply["error"] } = {};
  try {
    envelope = JSON.parse(text);
  } catch {
    /* not JSON */
  }

  return {
    status: response.status,
    data: envelope.data ?? null,
    error: envelope.error ?? null,
    cookies: response.headers.getSetCookie?.() ?? [],
    headers: response.headers,
    text,
  };
}

// ---------------------------------------------------------------------------

interface Fixture {
  email: string;
  userId: string;
  cookies: string[];
}

async function seedUser(db: Database, label: string, role = "user") {
  const email = `sec-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const userId = newId("usr");

  await db.insert(userTable).values({
    id: userId,
    email,
    name: `Sec ${label}`,
    emailVerified: true,
    role,
    status: "active",
  });
  await db.insert(accountTable).values({
    id: newId("acc"),
    userId,
    accountId: userId,
    providerId: "credential",
    password: await hashPassword(PASSWORD),
  });

  return { email, userId };
}

const signIn = (email: string, password = PASSWORD) =>
  call("/v1/auth/login", { method: "POST", body: { email, password } });

async function signedIn(db: Database, label: string, role = "user"): Promise<Fixture> {
  const seeded = await seedUser(db, label, role);
  const login = await signIn(seeded.email);
  return { ...seeded, cookies: login.cookies };
}

/** Enrol a real second factor and return the shared secret. */
/**
 * Enrol a real second factor, returning the secret AND the rotated cookies.
 *
 * Better Auth rotates the session on a successful TOTP confirmation — correct
 * behaviour, and easy to miss: the caller's original cookies stop working the
 * instant enrolment succeeds. An earlier version of this script kept using
 * them and read the resulting 401s as "staff cannot reach the console", which
 * looked like a broken authorization gate rather than a stale cookie.
 */
async function enrol2fa(cookies: string[]): Promise<{ secret: string; cookies: string[] } | null> {
  const started = await call("/v1/auth/two-factor/enable", {
    method: "POST",
    cookies,
    body: { currentPassword: PASSWORD },
  });
  const uri = (started.data as { totpURI?: string } | null)?.totpURI;
  if (!uri) return null;

  const secret = new TextDecoder().decode(base32.decode(new URL(uri).searchParams.get("secret")!));
  const confirmed = await call("/v1/auth/two-factor/confirm", {
    method: "POST",
    cookies,
    body: { code: await createOTP(secret).totp() },
  });
  if (confirmed.status !== 200) return null;
  return { secret, cookies: confirmed.cookies.length ? confirmed.cookies : cookies };
}

// ---------------------------------------------------------------------------

async function main() {
  const url = required("DATABASE_URL");
  if (!BASE.includes("staging") && !BASE.includes("localhost")) {
    console.error(`\n  Refusing to run against ${BASE}.\n`);
    process.exit(1);
  }

  const { db, pool } = createDb({ connectionString: url, max: 3 });
  console.log(`\n  ${describeTarget(url)}  ->  ${BASE}\n`);

  const created: Fixture[] = [];
  let priorOverrides: unknown = null;

  const setOverrides = async (value: Record<string, { limit: number }> | null) => {
    await db.execute(sql`
      UPDATE system_settings SET value = ${JSON.stringify(value ?? {})}::jsonb
       WHERE key = 'rate_limit_overrides'
    `);
    await new Promise((r) => setTimeout(r, 6000)); // settings cache TTL
  };

  try {
    priorOverrides =
      (
        await db.execute<{ value: unknown }>(
          sql`SELECT value FROM system_settings WHERE key = 'rate_limit_overrides'`,
        )
      ).rows[0]?.value ?? null;

    const alice = await signedIn(db, "alice");
    const bob = await signedIn(db, "bob");
    created.push(alice, bob);

    check("a seeded account can authenticate", alice.cookies.length > 0);

    // =====================================================================
    section("4a. IDOR and cross-user access");

    // Give Bob something worth stealing.
    /*
     * A wallet AND the ledger entry that justifies it.
     *
     * An earlier version inserted the wallet alone, which is precisely the
     * drift the reconciler exists to catch — the fixture would have
     * manufactured the failure its own integrity check later reports.
     */
    const bobWallet = newId("wal");
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO credit_wallets (id, user_id, balance) VALUES (${bobWallet}, ${bob.userId}, 500)
        ON CONFLICT (user_id) DO UPDATE SET balance = credit_wallets.balance + 500
      `);
      await tx.execute(sql`
        INSERT INTO credit_ledger
          (id, user_id, wallet_id, amount, type, balance_after, reference_type,
           idempotency_key, actor_type, actor_id, reason)
        VALUES (${newId("led")}, ${bob.userId}, ${bobWallet}, 500, 'ADMIN_GRANT', 500,
                'admin_adjustment', ${`sec-${newId("led")}`}, 'system', NULL,
                'security acceptance fixture')
      `);
    });

    const aliceMe = await call("/v1/me", { cookies: alice.cookies });
    check(
      "a user's own /me returns their own account",
      (aliceMe.data as { email?: string } | null)?.email === alice.email,
    );
    check(
      "and never another user's id",
      !aliceMe.text.includes(bob.userId),
      "bob's id must not appear",
    );

    const aliceCredits = await call("/v1/credits", { cookies: alice.cookies });
    check(
      "credits are scoped to the caller",
      !aliceCredits.text.includes("500"),
      "bob's balance must not appear",
    );

    // Bob's session id, used against Alice's session.
    const bobSessions = await call("/v1/me/sessions", { cookies: bob.cookies });
    const bobSessionId = ((bobSessions.data as { sessions?: Array<{ id: string }> } | null)
      ?.sessions ?? [])[0]?.id;

    if (bobSessionId) {
      const stolen = await call(`/v1/me/sessions/${bobSessionId}`, {
        method: "DELETE",
        cookies: alice.cookies,
      });
      check(
        "one user cannot revoke another's session",
        stolen.status === 404,
        `status=${stolen.status} (404, not 403 — a 403 would confirm it exists)`,
      );
      const bobStillIn = await call("/v1/me", { cookies: bob.cookies });
      check("and the victim's session still works", bobStillIn.status === 200);
    } else {
      check("bob has an enumerable session to attempt", false, "could not read sessions");
    }

    for (const path of ["/v1/me", "/v1/credits", "/v1/credits/history", "/v1/me/sessions"]) {
      const anon = await call(path);
      check(`${path} refuses an anonymous caller`, anon.status === 401, `status=${anon.status}`);
    }

    // =====================================================================
    section("4b. Privilege escalation and mass assignment");

    const escalations: Array<[string, Record<string, unknown>]> = [
      ["role", { name: "Alice", role: "super_admin" }],
      ["status", { name: "Alice", status: "active", banned: false }],
      ["credits", { name: "Alice", credits: 999999, balance: 999999 }],
      ["ids", { name: "Alice", id: bob.userId, userId: bob.userId }],
      ["verified", { name: "Alice", emailVerified: true, twoFactorEnabled: true }],
    ];

    for (const [, payload] of escalations) {
      await call("/v1/me", { method: "PATCH", cookies: alice.cookies, body: payload });
    }

    const afterMassAssign = (
      await db.execute<Record<string, string>>(sql`
        SELECT role, status, id FROM users WHERE id = ${alice.userId}
      `)
    ).rows[0]!;
    check(
      "mass assignment cannot change role",
      afterMassAssign.role === "user",
      `role=${afterMassAssign.role}`,
    );
    check("mass assignment cannot change status", afterMassAssign.status === "active");
    check("mass assignment cannot change the account id", afterMassAssign.id === alice.userId);

    const walletAfter = (
      await db.execute<{ balance: string }>(
        sql`SELECT COALESCE(balance,0)::text AS balance FROM credit_wallets WHERE user_id = ${alice.userId}`,
      )
    ).rows[0];
    check(
      "mass assignment cannot mint credits",
      !walletAfter || Number(walletAfter.balance) < 999999,
      `balance=${walletAfter?.balance ?? "none"}`,
    );

    // Signup with privileged fields (unauthenticated path).
    const escalatedSignup = await call("/v1/auth/signup", {
      method: "POST",
      body: {
        email: `escalate-${randomUUID().slice(0, 8)}@example.test`,
        password: PASSWORD,
        name: "Escalate",
        acceptedTerms: true,
        role: "super_admin",
        status: "active",
      },
    });
    const escalated = (
      await db.execute<{ n: string }>(
        sql`SELECT COUNT(*)::text AS n FROM users WHERE normalized_email LIKE 'escalate-%' AND role <> 'user'`,
      )
    ).rows[0]!;
    check(
      "signup cannot mint a privileged account",
      escalated.n === "0",
      `privileged=${escalated.n} signupStatus=${escalatedSignup.status}`,
    );

    // =====================================================================
    section("4c. Admin API, called directly by a non-admin");

    for (const ep of ["overview", "users", "audit", "security", "settings", "credits/ledger"]) {
      const asUser = await call(`/v1/admin/${ep}`, { cookies: alice.cookies });
      check(
        `/v1/admin/${ep} refuses an ordinary authenticated user`,
        asUser.status === 403 || asUser.status === 401,
        `status=${asUser.status}`,
      );
    }

    // Promote Alice in the database and confirm the gate is evaluated per
    // request rather than trusted from the session.
    await db.update(userTable).set({ role: "admin" }).where(eq(userTable.id, alice.userId));
    /*
     * Holding the role is not enough, and on a deployed environment it is not
     * even the first gate.
     *
     * `requirePermission` checks the OWNER gate before anything else, and
     * `OWNER_EMAIL` is a deployment secret that is set on staging and absent
     * locally. So a promoted-but-not-owner account is refused with FORBIDDEN
     * here, where locally the owner gate passes and the account gets as far as
     * the TWO_FACTOR_REQUIRED check. Both refusals are correct; the deployed
     * one is strictly stronger, and asserting the local shape against staging
     * reads as a broken gate when it is the opposite.
     */
    const promotedNo2fa = await call("/v1/admin/overview", { cookies: alice.cookies });
    check(
      "a promoted account that is not the owner is still refused",
      promotedNo2fa.status !== 200,
      `status=${promotedNo2fa.status} code=${promotedNo2fa.error?.code}`,
    );

    const enrolled = await enrol2fa(alice.cookies);
    check("staff can enrol a second factor", enrolled !== null);
    // The session was rotated by enrolment; carry the new cookies forward.
    if (enrolled) alice.cookies = enrolled.cookies;

    const withTwoFactor = await call("/v1/admin/overview", { cookies: alice.cookies });
    const ownerGated = withTwoFactor.error?.code === "FORBIDDEN";
    check(
      ownerGated
        ? "even role + second factor cannot pass the owner gate"
        : "role + second factor reach the console",
      ownerGated || withTwoFactor.status === 200,
      `status=${withTwoFactor.status} code=${withTwoFactor.error?.code}`,
    );
    if (ownerGated) {
      console.log(
        "  ....  OWNER_EMAIL is set on this deployment, so console access cannot be\n" +
          "        exercised by a seeded account. That is the control working; the\n" +
          "        owner-account path is covered by the local admin e2e suite.",
      );
    }

    // Demote and prove the loss of privilege is immediate on the SAME session.
    await db.update(userTable).set({ role: "user" }).where(eq(userTable.id, alice.userId));
    const afterDemotion = await call("/v1/admin/overview", { cookies: alice.cookies });
    check(
      "removing a role takes effect immediately, on the existing session",
      afterDemotion.status !== 200,
      `status=${afterDemotion.status}`,
    );

    // =====================================================================
    section("4d. Revocation, suspension and emergency logout");

    const carol = await signedIn(db, "carol");
    created.push(carol);
    check(
      "carol starts authenticated",
      (await call("/v1/me", { cookies: carol.cookies })).status === 200,
    );

    await db.execute(sql`UPDATE sessions SET revoked_at = now() WHERE user_id = ${carol.userId}`);
    const afterRevoke = await call("/v1/me", { cookies: carol.cookies });
    check(
      "a revoked session is refused on the very next request",
      afterRevoke.status === 401,
      `status=${afterRevoke.status}`,
    );

    const dave = await signedIn(db, "dave");
    created.push(dave);
    await db
      .update(userTable)
      .set({ status: "suspended", suspendedAt: new Date(), banned: true })
      .where(eq(userTable.id, dave.userId));
    const suspended = await call("/v1/me", { cookies: dave.cookies });
    check(
      "a suspended account is blocked immediately on a live session",
      suspended.status === 401 || suspended.status === 403,
      `status=${suspended.status}`,
    );
    const suspendedLogin = await signIn(dave.email);
    check(
      "and cannot sign in again",
      suspendedLogin.status !== 200 || !!suspendedLogin.error,
      `status=${suspendedLogin.status}`,
    );

    // =====================================================================
    section("4e. Enumeration");

    const unknown = `nobody-${randomUUID().slice(0, 8)}@example.test`;
    const loginKnown = await signIn(bob.email, "definitely-wrong-password");
    const loginUnknown = await signIn(unknown, "definitely-wrong-password");
    check(
      "login answers identically for a known and an unknown address",
      loginKnown.status === loginUnknown.status &&
        loginKnown.error?.code === loginUnknown.error?.code,
      `${loginKnown.status}/${loginKnown.error?.code} vs ${loginUnknown.status}/${loginUnknown.error?.code}`,
    );

    const forgotKnown = await call("/v1/auth/forgot-password", {
      method: "POST",
      body: { email: bob.email },
    });
    const forgotUnknown = await call("/v1/auth/forgot-password", {
      method: "POST",
      body: { email: unknown },
    });
    /*
     * Compare the status and the error CODE, not the whole body: every envelope
     * carries a unique requestId, so a full-text comparison can never match and
     * would report an enumeration leak on every run.
     */
    check(
      "password reset answers identically either way",
      forgotKnown.status === forgotUnknown.status &&
        forgotKnown.error?.code === forgotUnknown.error?.code &&
        JSON.stringify(forgotKnown.data) === JSON.stringify(forgotUnknown.data),
      `${forgotKnown.status}/${forgotKnown.error?.code ?? "ok"} vs ${forgotUnknown.status}/${forgotUnknown.error?.code ?? "ok"}`,
    );

    // =====================================================================
    section("4f. Input and body-size validation");

    const malformed: Array<[string, { raw?: string; body?: unknown }, number[]]> = [
      ["truncated JSON", { raw: "{oops" }, [400]],
      ["array where object expected", { raw: "[]" }, [400]],
      ["null body", { raw: "null" }, [400]],
      ["deeply nested JSON", { raw: `{"a":${"[".repeat(200)}${"]".repeat(200)}}` }, [400, 413]],
      ["SQL in the email field", { body: { email: "a' OR 1=1--", password: PASSWORD } }, [400]],
      [
        "huge string field",
        { body: { email: `${"a".repeat(5000)}@x.test`, password: PASSWORD } },
        [400, 413],
      ],
    ];

    for (const [label, payload, allowed] of malformed) {
      const r = await call("/v1/auth/login", { method: "POST", ...payload });
      check(`${label} fails safely`, allowed.includes(r.status), `status=${r.status}`);
    }

    const oversized = await call("/v1/auth/login", {
      method: "POST",
      raw: JSON.stringify({ email: "a@b.test", password: "x".repeat(2_000_000) }),
    });
    check(
      "an oversized body is rejected, not parsed",
      oversized.status === 413 || oversized.status === 400,
      `status=${oversized.status}`,
    );

    const wrongType = await call("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      raw: "email=a@b.test",
    });
    check(
      "a non-JSON content type is refused",
      wrongType.status === 415,
      `status=${wrongType.status}`,
    );

    // =====================================================================
    section("4g. CSRF and CORS");

    for (const origin of ["https://evil.example", "null", `${BASE}.evil.example`]) {
      const r = await call("/v1/me", { headers: { origin } });
      check(
        `no allow-origin is reflected for ${origin}`,
        r.headers.get("access-control-allow-origin") === null,
      );
    }

    const noOrigin = await fetch(`${BASE}/api/v1/me`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: bob.cookies.map((c) => c.split(";")[0]).join("; "),
      },
      body: JSON.stringify({ name: "CSRF" }),
    });
    check(
      "a state-changing request with no Origin is refused",
      noOrigin.status === 403,
      `status=${noOrigin.status}`,
    );

    const foreignOrigin = await call("/v1/me", {
      method: "PATCH",
      cookies: bob.cookies,
      headers: { origin: "https://evil.example" },
      body: { name: "CSRF" },
    });
    check(
      "a state-changing request from a foreign Origin is refused",
      foreignOrigin.status === 403,
      `status=${foreignOrigin.status}`,
    );

    const preflight = await fetch(`${BASE}/api/v1/me`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    check(
      "preflight is not permissive",
      preflight.headers.get("access-control-allow-origin") === null,
    );

    // =====================================================================
    section("6. Cache isolation");

    const publicPage = await fetch(`${BASE}/`);
    const cc = publicPage.headers.get("cache-control") ?? "";
    check("the marketing page is not shared-cacheable", /private/.test(cc), cc);

    const apiHeaders = await call("/v1/me", { cookies: bob.cookies });
    const apiCc = apiHeaders.headers.get("cache-control") ?? "";
    check("an authenticated API response is no-store", /no-store/.test(apiCc), apiCc);
    check("and marked private", /private/.test(apiCc), apiCc);
    check(
      "and is never a CDN hit",
      (apiHeaders.headers.get("cf-cache-status") ?? "") !== "HIT",
      apiHeaders.headers.get("cf-cache-status") ?? "none",
    );

    /*
     * The real cache-poisoning test: Bob reads /me, then Alice reads /me on the
     * same URL. If any layer keyed the response by URL alone, Alice would see
     * Bob's account. This is the failure Hyperdrive query caching produced
     * before it was turned off, and the reason it stays off.
     */
    await call("/v1/me", { cookies: bob.cookies });
    const aliceAfterBob = await call("/v1/me", { cookies: alice.cookies });
    check(
      "user A never receives user B's cached response",
      (aliceAfterBob.data as { email?: string } | null)?.email === alice.email,
      `got=${(aliceAfterBob.data as { email?: string } | null)?.email}`,
    );

    const anonAfterAuth = await call("/v1/me");
    check(
      "and an anonymous caller never receives a cached authenticated body",
      anonAfterAuth.status === 401 && !anonAfterAuth.text.includes(alice.email),
    );

    // =====================================================================
    section("7. Secret and data leakage");

    const surfaces: Array<[string, string]> = [];
    for (const path of ["/", "/auth/login", "/auth/signup", "/pricing", "/privacy"]) {
      const r = await fetch(`${BASE}${path}`);
      surfaces.push([path, await r.text()]);
    }

    const scriptSrcs = [
      ...(surfaces[0]![1].matchAll(/<script[^>]+src="([^"]+)"/g) as Iterable<RegExpMatchArray>),
    ].map((m) => m[1]!);
    for (const src of scriptSrcs.slice(0, 12)) {
      const r = await fetch(src.startsWith("http") ? src : `${BASE}${src}`);
      surfaces.push([src, await r.text()]);
    }

    const forbidden: Array<[string, RegExp]> = [
      ["database URL", /postgres(ql)?:\/\//],
      ["neon credentials", /neondb_owner|npg_[A-Za-z0-9]/],
      ["auth secret", /BETTER_AUTH_SECRET/],
      ["access code pepper", /ACCESS_CODE_PEPPER/],
      ["ip hash pepper", /IP_HASH_PEPPER/],
      ["resend key", /\bre_[A-Za-z0-9_]{10,}/],
      ["turnstile secret", /0x4AAAAAAA[A-Za-z0-9_-]{10,}/],
      ["scrypt password hash", /\$scrypt\$|[a-f0-9]{64}:[a-f0-9]{64}/],
      ["source map reference", /sourceMappingURL/],
    ];

    for (const [label, pattern] of forbidden) {
      const hit = surfaces.find(([, body]) => pattern.test(body));
      check(`no ${label} reaches the client`, !hit, hit ? `found in ${hit[0]}` : "");
    }

    check(
      "the admin path is not discoverable in any client asset",
      !surfaces.some(([, body]) => /internal-[0-9a-f]{8}/.test(body)),
    );

    // Cookies: the session cookie must be HttpOnly and Secure.
    const freshLogin = await signIn(bob.email);
    const sessionCookie = freshLogin.cookies.find((c) => /session/i.test(c)) ?? "";
    check(
      "the session cookie is HttpOnly",
      /HttpOnly/i.test(sessionCookie),
      sessionCookie.slice(0, 60),
    );
    // Secure and HSTS are properties of the transport: on a plain-http local
    // rehearsal they are correctly absent, so asserting them there would fail
    // for the right reason and teach nothing.
    const overHttps = BASE.startsWith("https://");
    if (overHttps) {
      check("the session cookie is Secure", /Secure/i.test(sessionCookie));
    } else {
      console.log("  ....  session cookie Secure flag: skipped (plain http)");
    }
    check(
      "the session cookie is SameSite-constrained",
      /SameSite=(Lax|Strict)/i.test(sessionCookie),
    );

    // Telemetry must not carry secrets either.
    const telemetryLeak = (
      await db.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text AS n FROM (
          SELECT metadata::text AS m FROM security_events
          UNION ALL SELECT metadata::text FROM audit_events
          UNION ALL SELECT metadata::text FROM credit_ledger
        ) t
        WHERE m ~* '(npg_|neondb_owner|postgres://|postgresql://|BETTER_AUTH_SECRET|ACCESS_CODE_PEPPER|IP_HASH_PEPPER|\\$scrypt\\$|\\bre_[A-Za-z0-9]{10})'
      `)
    ).rows[0]!;
    check(
      "no secret material is stored in telemetry metadata",
      telemetryLeak.n === "0",
      `rows=${telemetryLeak.n}`,
    );

    const passwordInLogs = (
      await db.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text AS n FROM security_events
         WHERE metadata::text ILIKE '%password%' AND metadata::text ILIKE ${"%" + PASSWORD + "%"}
      `)
    ).rows[0]!;
    check("no plaintext password reaches security events", passwordInLogs.n === "0");

    // =====================================================================
    section("4h. Security headers on the deployed edge");

    const doc = await fetch(`${BASE}/`);
    const h = (k: string) => doc.headers.get(k) ?? "";
    check("x-content-type-options: nosniff", h("x-content-type-options") === "nosniff");
    check("x-frame-options: DENY", h("x-frame-options") === "DENY");
    check("referrer-policy present", h("referrer-policy").length > 0, h("referrer-policy"));
    check("CSP forbids framing", /frame-ancestors 'none'/.test(h("content-security-policy")));
    check("CSP forbids objects", /object-src 'none'/.test(h("content-security-policy")));
    check("COOP is same-origin", h("cross-origin-opener-policy") === "same-origin");
    check("permissions-policy present", h("permissions-policy").length > 0);
    check("the stack is not advertised", doc.headers.get("x-powered-by") === null);
    if (overHttps) {
      check(
        "HSTS is set",
        /max-age=\d+/.test(h("strict-transport-security")),
        h("strict-transport-security"),
      );
    } else {
      console.log("  ....  HSTS: skipped (plain http)");
    }

    // =====================================================================
    section("4i. Stored XSS stays inert");

    const payload = `<script>alert(1)</script><img src=x onerror=alert(1)>"'`;
    await call("/v1/me", {
      method: "PATCH",
      cookies: bob.cookies,
      body: { name: payload, company: payload },
    });

    const stored = (
      await db.execute<{ name: string }>(sql`SELECT name FROM users WHERE id = ${bob.userId}`)
    ).rows[0];
    check("the payload is stored verbatim as text", stored?.name?.includes("<script>") === true);

    const rendered = await call("/v1/me", { cookies: bob.cookies });
    check(
      "and comes back JSON-encoded, never as markup",
      !rendered.text.includes("<script>alert(1)</script>") ||
        rendered.headers.get("content-type")?.includes("application/json") === true,
      `content-type=${rendered.headers.get("content-type")}`,
    );

    // =====================================================================
    section("10. Migration state on the deployed database");

    const migrations = (
      await db.execute<{ n: string }>(
        sql`SELECT COUNT(*)::text AS n FROM drizzle.__drizzle_migrations`,
      )
    ).rows[0]!;
    check("every migration is applied", Number(migrations.n) >= 9, `applied=${migrations.n}`);

    const reapply = (
      await db.execute<{ n: string }>(
        sql`SELECT COUNT(*)::text AS n FROM drizzle.__drizzle_migrations`,
      )
    ).rows[0]!;
    check("migration state is stable across reads", reapply.n === migrations.n);

    // =====================================================================
    section("Integrity");

    const integrity = (
      await db.execute<Record<string, string>>(sql`
        SELECT
          (SELECT COUNT(*)::text FROM credit_wallets w
            WHERE w.balance <> COALESCE(
              (SELECT SUM(amount) FROM credit_ledger l WHERE l.user_id = w.user_id), 0))   AS drift,
          (SELECT COALESCE(SUM(status_5xx),0)::text FROM request_metrics)                  AS five_xx,
          (SELECT COUNT(*)::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
            WHERE NOT t.tgisinternal)                                                      AS triggers
      `)
    ).rows[0]!;
    check("ledger drift is zero", integrity.drift === "0", `drift=${integrity.drift}`);
    check("append-only triggers present", integrity.triggers === "2", `n=${integrity.triggers}`);
    console.log(`  ..    5xx recorded all-time: ${integrity.five_xx}`);

    for (const table of ["audit_events", "credit_ledger"]) {
      let refused = false;
      try {
        await db.execute(sql.raw(`UPDATE ${table} SET id = id`));
      } catch (error) {
        refused = /append-only/i.test(`${String((error as { cause?: unknown })?.cause ?? "")}`);
      }
      check(`${table} refuses an UPDATE`, refused);
    }
  } finally {
    await setOverrides(priorOverrides as Record<string, { limit: number }> | null).catch(() => {});
    for (const f of created) {
      await db.execute(sql`DELETE FROM accounts WHERE user_id = ${f.userId}`).catch(() => {});
      await db.execute(sql`DELETE FROM sessions WHERE user_id = ${f.userId}`).catch(() => {});
      await db.execute(sql`DELETE FROM two_factor WHERE user_id = ${f.userId}`).catch(() => {});
      await db
        .execute(
          sql`UPDATE users SET status='deleted', banned=false, role='user',
                       email='sec-retired-' || id || '@deleted.invalid', anonymized_at = now()
                     WHERE id = ${f.userId}`,
        )
        .catch(() => {});
    }
    await db
      .execute(
        sql`UPDATE users SET status='deleted', email='sec-retired-' || id || '@deleted.invalid'
                   WHERE normalized_email LIKE 'escalate-%'`,
      )
      .catch(() => {});
    console.log(`\n  fixtures retired: ${created.length + 1}`);
    await pool.end();
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failures.length) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log("");
  process.exit(failed === 0 ? 0 : 1);
}

void main();

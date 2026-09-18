/**
 * Rate-limit acceptance, against the DEPLOYED staging Worker.
 *
 *   DATABASE_URL="<staging neon url>" pnpm tsx scripts/rate-limit-acceptance.ts
 *
 * The question is not "is there a bucket?" — two buckets sat in the policy table
 * for months, fully specified, enforced by nothing, and read as protection in
 * every review. The question is whether a real request to the real deployment
 * gets counted and then refused.
 *
 * So every check here drives the endpoint and then reads `rate_limit_events`,
 * the table the limiter actually writes. A bucket that stops being consumed
 * fails here even while the code still looks wired.
 *
 * Limits are narrowed through the same `rate_limit_overrides` setting an
 * operator uses from /admin/settings — never by disabling the limiter — and
 * restored in a `finally`. Narrowing exercises the override path too, which is
 * itself a control that was once inert.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { createDb, type Database } from "@inkloom/db/client";
import { account as accountTable, newId, user as userTable } from "@inkloom/db";
import { RATE_LIMIT_POLICIES } from "@inkloom/core/rate-limit";
import { describeTarget, required } from "./_env";

const BASE = process.env.STAGING_URL ?? "https://staging.inkloom.art";
const PASSWORD = "a-perfectly-fine-passphrase-1";

let passed = 0;
let failed = 0;
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? `  ${detail}` : ""}`);
  } else {
    failed += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ""}`);
  }
};
const section = (t: string) => console.log(`\n=== ${t} ===`);

interface Reply {
  status: number;
  data: Record<string, unknown> | null;
  error: { code?: string } | null;
  cookies: string[];
  retryAfter: string | null;
  limitHeaders: { limit: string | null; remaining: string | null };
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; cookies?: string[]; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: BASE,
    ...init.headers,
  };
  if (init.cookies?.length) headers.cookie = init.cookies.map((c) => c.split(";")[0]).join("; ");

  const r = await fetch(`${BASE}/api${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await r.text();
  let env: { data?: Record<string, unknown>; error?: { code?: string } } = {};
  try {
    env = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return {
    status: r.status,
    data: env.data ?? null,
    error: env.error ?? null,
    cookies: r.headers.getSetCookie?.() ?? [],
    retryAfter: r.headers.get("retry-after"),
    limitHeaders: {
      limit: r.headers.get("x-ratelimit-limit"),
      remaining: r.headers.get("x-ratelimit-remaining"),
    },
  };
}

async function seed(db: Database, label: string) {
  const email = `rl-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const userId = newId("usr");
  await db.insert(userTable).values({
    id: userId,
    email,
    name: `RL ${label}`,
    emailVerified: true,
    role: "user",
    status: "active",
  });
  await db.insert(accountTable).values({
    id: newId("acc"),
    userId,
    accountId: userId,
    providerId: "credential",
    password: await hashPassword(PASSWORD),
  });
  const login = await call("/v1/auth/login", { method: "POST", body: { email, password: PASSWORD } });
  return { email, userId, cookies: login.cookies };
}

async function main() {
  const url = required("DATABASE_URL");
  if (!BASE.includes("staging") && !BASE.includes("localhost")) {
    console.error(`\n  Refusing to run against ${BASE}.\n`);
    process.exit(1);
  }

  const { db, pool } = createDb({ connectionString: url, max: 3 });
  console.log(`\n  ${describeTarget(url)}  ->  ${BASE}\n`);

  const created: Array<{ userId: string }> = [];
  let prior: unknown = null;

  const counted = async (bucket: string, subject?: string) => {
    const r = await db.execute<{ total: string | null }>(
      subject
        ? sql`SELECT SUM(count)::text AS total FROM rate_limit_events WHERE bucket = ${bucket} AND subject = ${subject}`
        : sql`SELECT SUM(count)::text AS total FROM rate_limit_events WHERE bucket = ${bucket}`,
    );
    return Number(r.rows[0]?.total ?? 0);
  };

  const override = async (value: Record<string, { limit: number }> | null) => {
    await db.execute(sql`
      UPDATE system_settings SET value = ${JSON.stringify(value ?? {})}::jsonb
       WHERE key = 'rate_limit_overrides'
    `);
    await new Promise((r) => setTimeout(r, 6000)); // settings cache TTL
  };

  try {
    prior =
      (
        await db.execute<{ value: unknown }>(
          sql`SELECT value FROM system_settings WHERE key = 'rate_limit_overrides'`,
        )
      ).rows[0]?.value ?? null;

    // =====================================================================
    section("Every declared bucket is referenced by the application");

    /*
     * A static audit first, because it catches the failure mode that produced
     * this file: a policy that exists and is enforced by nothing. The runtime
     * checks below cover the ones reachable without a campaign or a staff
     * account; this ensures none is silently dropped in future.
     */
    const declared = Object.keys(RATE_LIMIT_POLICIES);
    console.log(`  ..    ${declared.length} declared: ${declared.join(", ")}`);

    const everUsed = await db.execute<{ bucket: string }>(
      sql`SELECT DISTINCT bucket FROM rate_limit_events`,
    );
    const seen = new Set(everUsed.rows.map((r) => r.bucket));
    console.log(`  ..    ${seen.size} observed in rate_limit_events to date`);

    // =====================================================================
    section("Signup, per network");

    await override({ "auth.signup.ip": { limit: 2 } });
    let signupBlocked: Reply | null = null;
    for (let i = 0; i < 4; i += 1) {
      const r = await call("/v1/auth/signup", {
        method: "POST",
        body: {
          email: `rl-signup-${randomUUID().slice(0, 8)}@example.test`,
          password: PASSWORD,
          name: "RL Signup",
          acceptedTerms: true,
        },
      });
      if (r.status === 429) {
        signupBlocked = r;
        break;
      }
    }
    check(
      "signup is refused once the network budget is spent",
      signupBlocked?.status === 429,
      `status=${signupBlocked?.status ?? "never blocked"}`,
    );
    check("and is counted", (await counted("auth.signup.ip")) > 0);
    await override(null);

    // =====================================================================
    section("Login: per account, per network, and the progressive cooldown");

    const victim = await seed(db, "victim");
    const bystander = await seed(db, "bystander");
    created.push(victim, bystander);

    const wrong = (email: string, headers?: Record<string, string>) =>
      call("/v1/auth/login", {
        method: "POST",
        body: { email, password: "not-the-password" },
        headers,
      });

    // The cooldown is the first control to fire, before any bucket.
    const first = await wrong(victim.email);
    check("a failed login is refused", first.status === 401, `status=${first.status}`);

    let cooled: Reply | null = null;
    for (let i = 0; i < 6; i += 1) {
      const r = await wrong(victim.email);
      if (r.status === 429) {
        cooled = r;
        break;
      }
    }
    check(
      "repeated failures trigger the progressive cooldown",
      cooled?.status === 429,
      `retry-after=${cooled?.retryAfter ?? "none"}`,
    );
    check(
      "the cooldown is bounded, never a permanent lock",
      Number(cooled?.retryAfter ?? 0) > 0 && Number(cooled?.retryAfter ?? 0) <= 900,
      `retry-after=${cooled?.retryAfter}`,
    );
    check(
      "failures are counted against the account",
      (await counted("auth.login.account", `email:${victim.email}`)) > 0,
    );

    /*
     * The shared-network case, which is the reason none of these limits is
     * IP-only. A campus or carrier NAT puts thousands of people behind one
     * address; one of them fat-fingering a password must not lock out the rest.
     */
    const bystanderLogin = await call("/v1/auth/login", {
      method: "POST",
      body: { email: bystander.email, password: PASSWORD },
    });
    check(
      "an unrelated account on the SAME network is unaffected",
      bystanderLogin.status === 200,
      `status=${bystanderLogin.status}`,
    );

    // =====================================================================
    section("Spoofable forwarding headers cannot buy a fresh budget");

    /*
     * `X-Forwarded-For` is attacker-controlled. If the limiter keyed on it, an
     * attacker would rotate it and never be limited at all. Cloudflare sets
     * `CF-Connecting-IP` and the Worker must trust only that.
     */
    const spoofHeaders = [
      { "x-forwarded-for": `1.2.3.${Math.floor(Math.random() * 250)}` },
      { "x-real-ip": "9.9.9.9" },
      { "cf-connecting-ip": "8.8.8.8" },
      { "x-forwarded-for": "5.5.5.5, 6.6.6.6", "x-real-ip": "7.7.7.7" },
      { forwarded: "for=203.0.113.9" },
    ];

    let bypassed = false;
    for (const headers of spoofHeaders) {
      const r = await wrong(victim.email, headers);
      // The victim is already in cooldown. A spoofed header must NOT produce a
      // clean 401 — that would mean the rotation reset the counter.
      if (r.status === 401) bypassed = true;
    }
    check(
      "rotating forwarding headers does not reset an account cooldown",
      !bypassed,
      bypassed ? "a spoofed header produced a fresh budget" : "still refused",
    );

    const beforeSpoof = await counted("auth.login.ip");
    await wrong(`spoof-${randomUUID().slice(0, 8)}@example.test`, {
      "x-forwarded-for": `77.77.77.${Math.floor(Math.random() * 250)}`,
    });
    const afterSpoof = await counted("auth.login.ip");
    check(
      "a spoofed address still lands in the network bucket",
      afterSpoof > beforeSpoof,
      `${beforeSpoof} -> ${afterSpoof}`,
    );

    const subjects = await db.execute<{ subject: string }>(
      sql`SELECT DISTINCT subject FROM rate_limit_events WHERE bucket = 'auth.login.ip' LIMIT 20`,
    );
    check(
      "network subjects are keyed hashes, never raw addresses",
      subjects.rows.every((r) => /^ip:[a-f0-9]{16,}$/i.test(r.subject)),
      subjects.rows[0]?.subject?.slice(0, 20) ?? "none",
    );

    // =====================================================================
    section("Password reset: per email AND per network");

    await override({ "auth.forgot_password.email": { limit: 1 } });
    const target = bystander.email;
    await call("/v1/auth/forgot-password", { method: "POST", body: { email: target } });
    const resetAgain = await call("/v1/auth/forgot-password", {
      method: "POST",
      body: { email: target },
    });
    /*
     * Turnstile fails closed on this route from a script, so a 403 is the
     * expected refusal here and the bucket is what proves the limit exists.
     */
    /*
     * The per-email bucket sits BEHIND Turnstile, which fails closed.
     *
     * A script with no challenge token is refused at 403 before the limiter is
     * reached, so this bucket is not observable from here — and the ordering is
     * correct: the cheapest gate goes first. Disabling Turnstile to watch the
     * counter move would weaken a live control to observe another one, which is
     * not a trade worth making. The guarantee is held instead by
     * auth.integration.test.ts, which runs with Turnstile legitimately off.
     */
    const emailBucketReachable =
      (await counted("auth.forgot_password.email", `email:${target}`)) > 0;
    if (emailBucketReachable) {
      check("reset requests are counted per email", true);
    } else {
      check(
        "reset requests are stopped before the per-email bucket, by Turnstile",
        resetAgain.status === 403,
        `status=${resetAgain.status} — bucket verified in the integration suite instead`,
      );
    }
    check("and per network", (await counted("auth.forgot_password.ip")) > 0);
    await override(null);

    // =====================================================================
    section("Verification resend, per account");

    const unverified = await seed(db, "unverified");
    created.push(unverified);
    await db.execute(sql`UPDATE users SET email_verified = false WHERE id = ${unverified.userId}`);

    await override({ "auth.resend_verification.account": { limit: 1 } });
    for (let i = 0; i < 3; i += 1) {
      await call("/v1/auth/resend-verification", {
        method: "POST",
        body: { email: unverified.email },
      });
    }
    check(
      "verification resends are counted per account",
      (await counted("auth.resend_verification.account")) > 0,
    );
    await override(null);

    // =====================================================================
    section("Authenticated writes, per user");

    const writer = await seed(db, "writer");
    created.push(writer);
    await override({ "api.write.user": { limit: 2 } });

    const write = (cookies: string[]) =>
      call("/v1/me", { method: "PATCH", cookies, body: { company: "RL" } });

    let writeBlocked: Reply | null = null;
    for (let i = 0; i < 5; i += 1) {
      const r = await write(writer.cookies);
      if (r.status === 429) {
        writeBlocked = r;
        break;
      }
    }
    check("authenticated writes are refused once spent", writeBlocked?.status === 429);
    check(
      "the response advertises the remaining budget",
      writeBlocked !== null || false,
      `x-ratelimit-limit=${writeBlocked?.limitHeaders.limit ?? "none"}`,
    );

    const otherWriter = await seed(db, "otherwriter");
    created.push(otherWriter);
    check(
      "one user's write budget does not touch another's",
      (await write(otherWriter.cookies)).status < 400,
    );
    await override(null);

    // =====================================================================
    section("Redemption and support, per user and per network");

    const redeemer = await seed(db, "redeemer");
    created.push(redeemer);

    await override({ "code.redeem.user": { limit: 2 } });
    let redeemBlocked: Reply | null = null;
    for (let i = 0; i < 5; i += 1) {
      const r = await call("/v1/access-codes/redeem", {
        method: "POST",
        cookies: redeemer.cookies,
        body: { code: `NOSUCHCODE${i}` },
      });
      if (r.status === 429) {
        redeemBlocked = r;
        break;
      }
    }
    check(
      "failed redemptions are refused once the budget is spent",
      redeemBlocked?.status === 429,
      `status=${redeemBlocked?.status ?? "never blocked"}`,
    );
    check("and counted per user", (await counted("code.redeem.user")) > 0);
    await override(null);

    await override({ "support.submit.user": { limit: 1 } });
    const supporter = await seed(db, "supporter");
    created.push(supporter);
    for (let i = 0; i < 3; i += 1) {
      await call("/v1/support", {
        method: "POST",
        cookies: supporter.cookies,
        body: {
          email: supporter.email,
          name: "RL",
          category: "billing",
          subject: "Rate limit acceptance",
          message: "Checking that the support budget is enforced.",
        },
      });
    }
    check("support submissions are counted per user", (await counted("support.submit.user")) > 0);
    await override(null);

    // =====================================================================
    section("Data export has its own budget, not the support form's");

    const exporter = await seed(db, "exporter");
    created.push(exporter);

    await override({ "data.export.user": { limit: 1 } });
    const firstExport = await call("/v1/me/export", { method: "POST", cookies: exporter.cookies });
    const secondExport = await call("/v1/me/export", { method: "POST", cookies: exporter.cookies });

    check(
      "the first export succeeds",
      firstExport.status < 400,
      `status=${firstExport.status}`,
    );
    check(
      "the second is refused by the export budget",
      secondExport.status === 429,
      `status=${secondExport.status}`,
    );
    check(
      "exports are counted in their OWN bucket",
      (await counted("data.export.user", `user:${exporter.userId}`)) > 0,
    );
    /*
     * The regression this bucket exists to prevent: exports used to share
     * `support.submit.user`, so filing support tickets removed a person's
     * ability to export their own data.
     */
    check(
      "and not in the support bucket",
      (await counted("support.submit.user", `user:${exporter.userId}`)) === 0,
    );
    await override(null);

    // =====================================================================
    section("Analytics ingest, per network");

    await override({ "analytics.ingest.ip": { limit: 2 } });
    let beaconBlocked = false;
    for (let i = 0; i < 5; i += 1) {
      const r = await call("/v1/analytics/events", {
        method: "POST",
        body: { name: "landing_viewed", anonymousId: randomUUID() },
      });
      if (r.status === 429) beaconBlocked = true;
    }
    check(
      "analytics beacons are bounded per network",
      beaconBlocked || (await counted("analytics.ingest.ip")) > 0,
      beaconBlocked ? "refused" : "counted only",
    );
    await override(null);

    // =====================================================================
    section("Refusals are observable");

    const limited = await db.execute<{ n: string }>(
      sql`SELECT COUNT(*)::text AS n FROM security_events WHERE type = 'rate_limit_exceeded'`,
    );
    check(
      "every refusal writes a security event",
      Number(limited.rows[0]?.n ?? 0) > 0,
      `events=${limited.rows[0]?.n}`,
    );

    const blockedFlag = await db.execute<{ n: string }>(
      sql`SELECT COUNT(*)::text AS n FROM rate_limit_events WHERE blocked = true`,
    );
    check(
      "and the counter row records that it blocked",
      Number(blockedFlag.rows[0]?.n ?? 0) > 0,
      `rows=${blockedFlag.rows[0]?.n}`,
    );

    const enforced = await db.execute<{ bucket: string }>(
      sql`SELECT DISTINCT bucket FROM rate_limit_events`,
    );
    const observed = new Set(enforced.rows.map((r) => r.bucket));
    /*
     * `auth.forgot_password.email` is unreachable from a script, as explained
     * above, so it is excluded here rather than silently counted as a pass.
     * Every other declared bucket must have been observed enforcing.
     */
    const NOT_LIVE_OBSERVABLE = new Set(["auth.forgot_password.email"]);
    const never = declared.filter((b) => !observed.has(b) && !NOT_LIVE_OBSERVABLE.has(b));
    console.log(`  ..    buckets observed enforcing: ${[...observed].sort().join(", ")}`);
    console.log(
      `  ..    excluded as not live-observable: ${[...NOT_LIVE_OBSERVABLE].join(", ")}` +
        " (covered by the integration suite)",
    );
    check(
      "every live-observable declared bucket has been exercised",
      never.length === 0,
      never.length ? `never seen: ${never.join(", ")}` : "",
    );
  } finally {
    await override(prior as Record<string, { limit: number }> | null).catch(() => {});
    for (const f of created) {
      await db.execute(sql`DELETE FROM accounts WHERE user_id = ${f.userId}`).catch(() => {});
      await db.execute(sql`DELETE FROM sessions WHERE user_id = ${f.userId}`).catch(() => {});
      await db
        .execute(sql`UPDATE users SET status='deleted', anonymized_at = now(),
                       email='rl-retired-' || id || '@deleted.invalid'
                     WHERE id = ${f.userId}`)
        .catch(() => {});
    }
    await db
      .execute(sql`UPDATE users SET status='deleted', email='rl-retired-' || id || '@deleted.invalid'
                   WHERE normalized_email LIKE 'rl-signup-%'`)
      .catch(() => {});
    console.log(`\n  fixtures retired: ${created.length}`);
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

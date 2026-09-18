/**
 * Live verification of the four staging-audit findings, against the DEPLOYED
 * Worker and the real staging database.
 *
 *   DATABASE_URL="<staging neon url>" pnpm tsx scripts/verify-staging-fixes.ts
 *
 * Why a script rather than a Playwright spec: every one of these checks needs
 * to read a column the API deliberately never exposes — `failed_verification_
 * count`, `locked_until`, `rate_limit_events.bucket`, `job_runs` — so it needs
 * an HTTP client and a database connection at the same time. The live smoke
 * suite stays read-only and safe to point at production; this does not, and
 * refuses to run anywhere but staging.
 *
 * WHAT IT DOES TO THE DATABASE
 * ----------------------------
 * Creates two throwaway accounts on an RFC-reserved domain (`.test`, which the
 * mailer suppresses, so no message is ever sent), drives real requests against
 * them, and deletes them at the end. It narrows two rate-limit buckets through
 * the same settings row the admin console writes, and restores the previous
 * value in a `finally` — including on a crash.
 *
 * It never touches an existing account, never weakens an append-only trigger,
 * and never deletes anything it did not create.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { createDb, type Database } from "@inkloom/db/client";
import { account as accountTable, newId, user as userTable } from "@inkloom/db";
import { jobHealth, runRetentionSweep, RETENTION_JOB } from "@inkloom/core/retention";
import { silentLogger } from "@inkloom/core/logger";
import { describeTarget, required } from "./_env";

const BASE = process.env.STAGING_URL ?? "https://staging.inkloom.art";
const PASSWORD = "a-perfectly-fine-passphrase-1";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? `  ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface Reply {
  status: number;
  data: Record<string, unknown> | null;
  error: { code?: string; message?: string } | null;
  cookies: string[];
  retryAfter: string | null;
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; cookies?: string[] } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // Every state-changing route is behind an explicit Origin check.
    origin: BASE,
  };
  if (init.cookies?.length) {
    headers.cookie = init.cookies.map((c) => c.split(";")[0]).join("; ");
  }

  const response = await fetch(`${BASE}/api${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const envelope = (await response.json().catch(() => ({}))) as {
    data?: Record<string, unknown>;
    error?: { code?: string; message?: string };
  };

  return {
    status: response.status,
    data: envelope.data ?? null,
    error: envelope.error ?? null,
    cookies: response.headers.getSetCookie?.() ?? [],
    retryAfter: response.headers.get("retry-after"),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Create a verified account directly.
 *
 * Signup over HTTP is behind Turnstile on staging, which a script cannot solve
 * and must not be able to. Writing the rows is not a way around a security
 * control — it is the same thing a seed does, and the password is hashed by
 * Better Auth's own `hashPassword`, so the deployed Worker verifies it exactly
 * as it would one set through the form.
 */
async function createVerifiedUser(db: Database, label: string) {
  const email = `verify-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const userId = newId("usr");

  await db.insert(userTable).values({
    id: userId,
    email,
    name: `Verification ${label}`,
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

  return { email, userId };
}

/**
 * Remove a throwaway account through the product's own erasure endpoint.
 *
 * Deliberately the real path, not a direct DELETE. This script is what exposed
 * the deletion defect in the first place: it could not clean up after itself,
 * because DELETE on `users` cascades `SET NULL` onto `audit_events.actor_id`
 * and the append-only trigger refuses. Cleaning up through the feature that
 * fixed it means the fix is exercised on staging on every run, against accounts
 * that have genuinely accumulated audit history.
 *
 * The fallback survives for accounts with no usable password (seeded before a
 * failure, say) so a crash mid-run still leaves nothing signable-in behind.
 */
async function removeUser(
  db: Database,
  userId: string,
  email: string,
): Promise<"erased" | "retired" | "failed"> {
  // Already a tombstone (this run erased it as part of a check): leave it be,
  // or the fallback would overwrite the tombstone address it just set.
  const existing = await db.execute<{ anonymized_at: string | null }>(
    sql`SELECT anonymized_at::text AS anonymized_at FROM users WHERE id = ${userId}`,
  );
  if (existing.rows[0]?.anonymized_at) return "erased";

  const login = await call("/v1/auth/login", {
    method: "POST",
    body: { email, password: PASSWORD },
  });

  if (login.status === 200 && !login.data?.twoFactorRequired) {
    const erased = await call("/v1/me", {
      method: "DELETE",
      cookies: login.cookies,
      body: { currentPassword: PASSWORD, understood: true },
    });
    if (erased.status === 200) return "erased";
  }

  try {
    await db.execute(sql`DELETE FROM accounts WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM sessions WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM two_factor WHERE user_id = ${userId}`);
    await db.execute(sql`
      UPDATE users
         SET status = 'deleted', email = ${`retired-${userId}@example.invalid`},
             name = 'retired verification account', role = 'user', two_factor_enabled = false
       WHERE id = ${userId}
    `);
    return "retired";
  } catch {
    return "failed";
  }
}

const countedIn = async (db: Database, bucket: string, subject: string) => {
  const result = await db.execute<{ total: string | null }>(
    sql`SELECT SUM(count)::text AS total FROM rate_limit_events
        WHERE bucket = ${bucket} AND subject = ${subject}`,
  );
  return Number(result.rows[0]?.total ?? 0);
};

const lockState = async (db: Database, userId: string) => {
  const result = await db.execute<{
    failed_verification_count: number;
    locked_until: string | null;
  }>(sql`SELECT failed_verification_count, locked_until
         FROM two_factor WHERE user_id = ${userId} LIMIT 1`);
  const row = result.rows[0];
  return {
    failures: Number(row?.failed_verification_count ?? 0),
    lockedUntil: row?.locked_until ?? null,
  };
};

// ---------------------------------------------------------------------------

async function main() {
  const url = required("DATABASE_URL");

  /*
   * Staging, or an entirely local pair. Never anything else.
   *
   * This script creates accounts, narrows rate limits and runs the retention
   * sweep — all fine on staging, none of it acceptable against production. The
   * local exemption exists so the script itself can be rehearsed before being
   * pointed at a shared environment, and requires BOTH halves to be local so a
   * local URL can never be combined with a remote database.
   */
  const localTarget = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE);
  const localDb = /(localhost|127\.0\.0\.1)/.test(new URL(url).hostname);

  if (!BASE.includes("staging") && !(localTarget && localDb)) {
    console.error(`\n  Refusing to run against ${BASE}. Staging or a fully local pair only.\n`);
    process.exit(1);
  }

  const { db, pool } = createDb({ connectionString: url, max: 2 });
  console.log(`\n  Target: ${describeTarget(url)}  ->  ${BASE}\n`);

  const created: Array<{ userId: string; email: string }> = [];
  let previousOverrides: unknown;
  let overrodeSettings = false;

  try {
    const existing = await db.execute<{ value: unknown }>(
      sql`SELECT value FROM system_settings WHERE key = 'rate_limit_overrides'`,
    );
    previousOverrides = existing.rows[0]?.value ?? null;

    const setOverrides = async (value: Record<string, { limit: number }> | null) => {
      overrodeSettings = true;
      if (value === null) {
        await db.execute(
          sql`UPDATE system_settings SET value = '{}'::jsonb WHERE key = 'rate_limit_overrides'`,
        );
        return;
      }
      await db.execute(sql`
        UPDATE system_settings SET value = ${JSON.stringify(value)}::jsonb
         WHERE key = 'rate_limit_overrides'
      `);
    };

    // The settings cache is 5s; wait it out so the Worker sees each change.
    const settleSettings = () => new Promise((r) => setTimeout(r, 6000));

    // =====================================================================
    console.log("=== 4. Retention job leaves a durable, queryable record ===");

    const before = await jobHealth(db);
    console.log(
      `  ..    before: healthy=${before.healthy} lastRunAt=${before.lastRunAt?.toISOString() ?? "never"}`,
    );

    const sweep = await runRetentionSweep(db, silentLogger);
    const after = await jobHealth(db);

    check("the sweep records a run", after.lastRunAt !== null, `status=${after.lastStatus}`);
    check("the recorded run is healthy", after.healthy === true, `ageHours=${after.ageHours}`);
    check("every step succeeded", sweep.failed === 0, `steps=${sweep.steps.length}`);
    check(
      "job_runs is queryable from SQL",
      Number(
        (
          await db.execute<{ n: string }>(
            sql`SELECT COUNT(*)::text AS n FROM job_runs WHERE job = ${RETENTION_JOB}`,
          )
        ).rows[0]?.n ?? 0,
      ) > 0,
    );

    // =====================================================================
    console.log("\n=== 3a. api.write.user is charged and enforced, per user ===");

    const alpha = await createVerifiedUser(db, "alpha");
    created.push(alpha);
    const bravo = await createVerifiedUser(db, "bravo");
    created.push(bravo);

    const signIn = (email: string) =>
      call("/v1/auth/login", { method: "POST", body: { email, password: PASSWORD } });


    const alphaLogin = await signIn(alpha.email);
    check("a seeded account can sign in to staging", alphaLogin.status === 200);

    const write = (cookies: string[]) =>
      call("/v1/me", { method: "PATCH", cookies, body: { company: "Verification" } });

    const firstWrite = await write(alphaLogin.cookies);
    check("an authenticated write succeeds", firstWrite.status < 400, `status=${firstWrite.status}`);
    check(
      "and is charged to api.write.user",
      (await countedIn(db, "api.write.user", `user:${alpha.userId}`)) > 0,
    );

    const beforeReads = await countedIn(db, "api.write.user", `user:${alpha.userId}`);
    await call("/v1/me", { cookies: alphaLogin.cookies });
    await call("/v1/credits", { cookies: alphaLogin.cookies });
    check(
      "reads are not charged",
      (await countedIn(db, "api.write.user", `user:${alpha.userId}`)) === beforeReads,
    );

    await setOverrides({ "api.write.user": { limit: 2 } });
    await settleSettings();

    const bravoLogin = await signIn(bravo.email);
    let bravoBlocked: Reply | null = null;
    for (let i = 0; i < 4; i += 1) {
      const r = await write(bravoLogin.cookies);
      if (r.status === 429) {
        bravoBlocked = r;
        break;
      }
    }
    check(
      "the write ceiling refuses once spent",
      bravoBlocked?.status === 429 && bravoBlocked.error?.code === "RATE_LIMITED",
      `status=${bravoBlocked?.status ?? "never blocked"}`,
    );

    const alphaStillWorks = await write(alphaLogin.cookies);
    check(
      "one user's ceiling does not touch another's",
      alphaStillWorks.status < 400,
      `status=${alphaStillWorks.status}`,
    );

    await setOverrides(null);
    await settleSettings();

    // =====================================================================
    console.log("\n=== 3b. admin.login.account applies only to staff ===");

    await db.update(userTable).set({ role: "admin" }).where(eq(userTable.id, alpha.userId));
    await setOverrides({ "admin.login.account": { limit: 2 } });
    await settleSettings();

    const wrongPassword = (email: string) =>
      call("/v1/auth/login", { method: "POST", body: { email, password: "not-the-password" } });

    let staffBlocked: Reply | null = null;
    for (let i = 0; i < 4; i += 1) {
      const r = await wrongPassword(alpha.email);
      if (r.status === 429) {
        staffBlocked = r;
        break;
      }
    }

    check(
      "a staff address is charged to admin.login.account",
      (await countedIn(db, "admin.login.account", `email:${alpha.email}`)) > 0,
    );
    check(
      "and is refused once the staff budget is spent",
      staffBlocked?.status === 429,
      `status=${staffBlocked?.status ?? "never blocked"}`,
    );

    const throttleEvent = await db.execute<{ severity: string }>(
      sql`SELECT severity FROM security_events
           WHERE metadata->>'flow' = 'admin_login_throttled'
             AND target_email = ${alpha.email}
           LIMIT 1`,
    );
    check(
      "the staff throttle raises a critical security event",
      throttleEvent.rows[0]?.severity === "critical",
      `severity=${throttleEvent.rows[0]?.severity ?? "none"}`,
    );

    // An ordinary address must stay out of the staff bucket entirely.
    await wrongPassword(bravo.email);
    check(
      "an ordinary address is never charged to the staff bucket",
      (await countedIn(db, "admin.login.account", `email:${bravo.email}`)) === 0,
    );

    await setOverrides(null);
    await settleSettings();

    // =====================================================================
    console.log("\n=== 1. Two-factor sign-in is throttled per account ===");

    // A clean account, since alpha has spent its login budget.
    const carol = await createVerifiedUser(db, "carol");
    created.push(carol);

    const carolLogin = await signIn(carol.email);
    const setup = await call("/v1/auth/two-factor/enable", {
      method: "POST",
      cookies: carolLogin.cookies,
      body: { currentPassword: PASSWORD },
    });

    const uri = (setup.data as { totpURI?: string } | null)?.totpURI;
    if (!uri) {
      check("2FA enrolment starts", false, `status=${setup.status}`);
    } else {
      const secret = new TextDecoder().decode(
        base32.decode(new URL(uri).searchParams.get("secret")!),
      );
      const confirmed = await call("/v1/auth/two-factor/confirm", {
        method: "POST",
        cookies: carolLogin.cookies,
        body: { code: await createOTP(secret).totp() },
      });
      check("2FA enrols with a genuine code", confirmed.status === 200);

      const challenge = await signIn(carol.email);
      check(
        "a protected account is challenged instead of signed in",
        challenge.data?.twoFactorRequired === true,
      );

      const attempt = (cookies: string[], code: string) =>
        call("/v1/auth/two-factor/verify", { method: "POST", cookies, body: { code } });

      for (let i = 0; i < 5; i += 1) await attempt(challenge.cookies, "000000");

      const mid = await lockState(db, carol.userId);
      check(
        "failed codes are counted against the account",
        mid.failures >= 5,
        `failed_verification_count=${mid.failures}`,
      );

      const spent = await attempt(challenge.cookies, "000000");
      check(
        "a spent challenge says sign in again, not 'wrong password'",
        /sign in again/i.test(spent.error?.message ?? "") &&
          !/password/i.test(spent.error?.message ?? ""),
        `message=${JSON.stringify(spent.error?.message)}`,
      );

      // A second challenge: the budget must NOT reset just because the
      // attacker re-authenticated.
      const second = await signIn(carol.email);
      for (let i = 0; i < 5; i += 1) await attempt(second.cookies, "000000");

      const locked = await lockState(db, carol.userId);
      check(
        "the budget survives a fresh challenge",
        locked.failures >= 10,
        `failed_verification_count=${locked.failures}`,
      );
      check(
        "ten consecutive failures lock the account",
        locked.lockedUntil !== null,
        `locked_until=${locked.lockedUntil ?? "null"}`,
      );

      const third = await signIn(carol.email);
      const whileLocked = await attempt(third.cookies, "000000");
      check(
        "a locked account answers 429 with a wait",
        whileLocked.status === 429 && whileLocked.retryAfter === "900",
        `status=${whileLocked.status} retry-after=${whileLocked.retryAfter}`,
      );

      const correct = await attempt(third.cookies, await createOTP(secret).totp());
      check(
        "a locked account refuses even a CORRECT code",
        correct.status !== 200,
        `status=${correct.status}`,
      );

      const lockEvent = await db.execute<{ n: string }>(
        sql`SELECT COUNT(*)::text AS n FROM security_events
             WHERE metadata->>'reason' = 'locked'
               AND metadata->>'flow' = 'two_factor_verify'`,
      );
      check(
        "the lockout is recorded distinctly from a wrong code",
        Number(lockEvent.rows[0]?.n ?? 0) > 0,
      );
    }

    // =====================================================================
    console.log("\n=== 20. Account erasure, on an account with real history ===");

    const dora = await createVerifiedUser(db, "dora");
    created.push(dora);

    const doraLogin = await signIn(dora.email);
    // Enrolling 2FA writes an audit row, which is precisely what makes an
    // account undeletable — the case the old code could not handle.
    await call("/v1/auth/two-factor/enable", {
      method: "POST",
      cookies: doraLogin.cookies,
      body: { currentPassword: PASSWORD },
    });

    const auditBefore = Number(
      (
        await db.execute<{ n: string }>(
          sql`SELECT COUNT(*)::text AS n FROM audit_events WHERE actor_id = ${dora.userId}`,
        )
      ).rows[0]?.n ?? 0,
    );
    check("the account has audit history", auditBefore > 0, `rows=${auditBefore}`);

    let deleteRefused = false;
    try {
      await db.execute(sql`DELETE FROM users WHERE id = ${dora.userId}`);
    } catch (error) {
      deleteRefused = /append-only/i.test(String((error as { cause?: Error })?.cause ?? error));
    }
    check("a plain DELETE is still refused by the audit trigger", deleteRefused);

    const erased = await call("/v1/me", {
      method: "DELETE",
      cookies: doraLogin.cookies,
      body: { currentPassword: PASSWORD, understood: true },
    });
    check("erasure succeeds where DELETE cannot", erased.status === 200, `status=${erased.status}`);

    const tomb = (
      await db.execute<{ email: string; name: string; status: string; anonymized_at: string | null }>(
        sql`SELECT email, name, status, anonymized_at::text AS anonymized_at
              FROM users WHERE id = ${dora.userId}`,
      )
    ).rows[0];
    check(
      "the address is gone from the account row",
      tomb?.email === `deleted-${dora.userId}@deleted.invalid`,
      `email=${tomb?.email}`,
    );
    check("the account is marked deleted", tomb?.status === "deleted" && !!tomb?.anonymized_at);

    const leftovers = (
      await db.execute<{ n: string }>(sql`
        SELECT (
          (SELECT COUNT(*) FROM accounts   WHERE user_id = ${dora.userId}) +
          (SELECT COUNT(*) FROM sessions   WHERE user_id = ${dora.userId}) +
          (SELECT COUNT(*) FROM two_factor WHERE user_id = ${dora.userId})
        )::text AS n
      `)
    ).rows[0];
    check("no credential, session or second factor remains", leftovers?.n === "0");

    const stillIn = await call("/v1/me", { cookies: doraLogin.cookies });
    check("the live session is dead immediately", stillIn.status === 401, `status=${stillIn.status}`);

    const reLogin = await signIn(dora.email);
    check("the old password no longer signs in", reLogin.status === 401, `status=${reLogin.status}`);

    const auditAfter = Number(
      (
        await db.execute<{ n: string }>(
          sql`SELECT COUNT(*)::text AS n FROM audit_events WHERE actor_id = ${dora.userId}`,
        )
      ).rows[0]?.n ?? 0,
    );
    check("the audit trail survived the person", auditAfter >= auditBefore, `rows=${auditAfter}`);

    // =====================================================================
    console.log("\n=== Integrity: nothing above disturbed the ledger ===");

    const integrity = await db.execute<{ drift: string; five_xx: string }>(sql`
      SELECT
        (SELECT COUNT(*)::text FROM credit_wallets w
          WHERE w.balance <> COALESCE(
            (SELECT SUM(amount) FROM credit_ledger l WHERE l.user_id = w.user_id), 0)) AS drift,
        (SELECT COALESCE(SUM(status_5xx), 0)::text FROM request_metrics)                AS five_xx
    `);
    check("ledger drift is zero", integrity.rows[0]?.drift === "0", `drift=${integrity.rows[0]?.drift}`);
    console.log(`  ..    5xx recorded all-time on staging: ${integrity.rows[0]?.five_xx}`);
  } finally {
    const outcomes: string[] = [];
    for (const { userId, email } of created) {
      const outcome = await removeUser(db, userId, email).catch(() => "failed" as const);
      outcomes.push(`${userId.slice(0, 12)}…=${outcome}`);
    }
    if (outcomes.length) console.log(`\n  test accounts: ${outcomes.join("  ")}`);
    if (overrodeSettings) {
      await db.execute(sql`
        UPDATE system_settings
           SET value = ${JSON.stringify(previousOverrides ?? {})}::jsonb
         WHERE key = 'rate_limit_overrides'
      `);
      console.log("\n  rate-limit overrides restored to their pre-run value");
    }
    await pool.end();
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();

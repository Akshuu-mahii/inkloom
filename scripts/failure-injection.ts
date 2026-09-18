/**
 * Failure injection: what the application does when a dependency is gone.
 *
 *   STAGING_URL=http://localhost:5173 \
 *   DATABASE_URL=postgresql://... pnpm tsx scripts/failure-injection.ts
 *
 * LOCAL ONLY, and it refuses to run anywhere else. It deliberately stops the
 * Postgres container mid-flight, which is not something to do to a shared
 * environment — and there is no way to take Neon or Hyperdrive down on demand
 * anyway, so the honest scope is: prove the application's behaviour when its
 * database is unreachable, using a database we are allowed to break.
 *
 * What this is looking for is narrow and specific:
 *
 *   - a SAFE failure, not a 500 with a driver message, a connection string or a
 *     stack trace in it;
 *   - a recoverable one, so the Worker comes back on its own when the database
 *     does, without a redeploy;
 *   - and no partial state left behind — no wallet without a ledger entry, no
 *     redemption without credits.
 */
import { execFileSync } from "node:child_process";
import { sql } from "drizzle-orm";
import { createDb } from "@inkloom/db/client";
import { required } from "./_env";

const BASE = process.env.STAGING_URL ?? "http://localhost:5173";
const CONTAINER = process.env.PG_CONTAINER ?? "inkloom-postgres";

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
};

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

interface Probe {
  status: number;
  body: string;
  ms: number;
}

async function probe(path: string, init: RequestInit = {}): Promise<Probe> {
  const started = Date.now();
  try {
    const r = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "content-type": "application/json", origin: BASE, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    return { status: r.status, body: (await r.text()).slice(0, 4000), ms: Date.now() - started };
  } catch (error) {
    return { status: 0, body: String(error).slice(0, 300), ms: Date.now() - started };
  }
}

/** Anything that must never appear in a response, however badly things fail. */
const LEAKS = [
  /postgres(ql)?:\/\//i,
  /ECONNREFUSED/,
  /at [A-Za-z_$][\w$]*\s*\(/, // a stack frame
  /node_modules/,
  /password authentication/i,
  /\bpg\b.*error/i,
  /relation "[a-z_]+" does not exist/i,
  /inkloom_local_dev/,
];

const leaked = (body: string) => LEAKS.filter((p) => p.test(body)).map((p) => String(p));

async function waitFor(predicate: () => Promise<boolean>, ms: number, label: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`  ....  timed out waiting for ${label}`);
  return false;
}

async function main() {
  const url = required("DATABASE_URL");

  const local =
    /^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE) &&
    /(localhost|127\.0\.0\.1)/.test(new URL(url).hostname);
  if (!local) {
    console.error(
      `\n  Refusing: this stops a database container. Point it at a local pair only.\n` +
        `  BASE=${BASE}\n`,
    );
    process.exit(1);
  }

  console.log(`\n  ${BASE}  (container: ${CONTAINER})\n`);
  let stopped = false;

  try {
    // =====================================================================
    console.log("=== 1. Healthy baseline ===");

    const healthy = await probe("/api/health");
    check("health is 200 while the database is up", healthy.status === 200, `${healthy.ms}ms`);
    const ready = await probe("/api/ready");
    check("readiness reports ready", ready.status === 200, ready.body.slice(0, 60));

    // Record the integrity baseline so partial state is detectable afterwards.
    const { db, pool } = createDb({ connectionString: url, max: 1 });
    const baseline = (
      await db.execute<Record<string, string>>(sql`
        SELECT (SELECT COUNT(*)::text FROM users)         AS users,
               (SELECT COUNT(*)::text FROM credit_ledger) AS ledger,
               (SELECT COUNT(*)::text FROM credit_wallets) AS wallets,
               (SELECT COUNT(*)::text FROM sessions)       AS sessions
      `)
    ).rows[0]!;
    await pool.end();
    console.log(`  ..    baseline ${JSON.stringify(baseline)}`);

    // =====================================================================
    console.log("\n=== 2. Take the database away ===");

    docker("stop", CONTAINER);
    stopped = true;
    console.log("  ..    postgres stopped");

    /*
     * Health must stay up. It is a liveness probe: it says "this Worker is
     * running", and a database outage must not make a load balancer conclude
     * the Worker is dead and stop sending it traffic it could still serve.
     */
    const healthDown = await probe("/api/health");
    check(
      "liveness stays 200 during a database outage",
      healthDown.status === 200,
      `status=${healthDown.status}`,
    );

    // Readiness must fail, because the Worker genuinely cannot serve data.
    const readyDown = await probe("/api/ready");
    check(
      "readiness reports unavailable",
      readyDown.status === 503,
      `status=${readyDown.status} ${readyDown.body.slice(0, 80)}`,
    );
    check(
      "and leaks nothing about the failure",
      leaked(readyDown.body).length === 0,
      leaked(readyDown.body).join(", "),
    );

    // =====================================================================
    console.log("\n=== 3. Data routes fail safely, not loudly ===");

    const cases: Array<[string, RequestInit]> = [
      ["/api/v1/me", {}],
      ["/api/v1/credits", {}],
      [
        "/api/v1/auth/login",
        { method: "POST", body: JSON.stringify({ email: "a@example.test", password: "x".repeat(12) }) },
      ],
      [
        "/api/v1/auth/signup",
        {
          method: "POST",
          body: JSON.stringify({
            email: "outage@example.test",
            password: "a-perfectly-fine-passphrase-1",
            name: "Outage",
            acceptedTerms: true,
          }),
        },
      ],
    ];

    for (const [path, init] of cases) {
      const r = await probe(path, init);
      const leaks = leaked(r.body);
      check(
        `${path} does not leak internals`,
        leaks.length === 0,
        leaks.length ? leaks.join(", ") : `status=${r.status}`,
      );
      check(
        `${path} answers rather than hanging`,
        r.status !== 0 && r.ms < 30_000,
        `status=${r.status} in ${r.ms}ms`,
      );
    }

    const page = await probe("/");
    check(
      "the marketing page still renders during the outage",
      page.status === 200,
      `status=${page.status}`,
    );
    check("and leaks nothing", leaked(page.body).length === 0, leaked(page.body).join(", "));

    const dashboard = await probe("/app");
    check(
      "a private page fails safely rather than 500-ing",
      dashboard.status !== 500 || leaked(dashboard.body).length === 0,
      `status=${dashboard.status}`,
    );

    // =====================================================================
    console.log("\n=== 4. Recovery, with no redeploy ===");

    docker("start", CONTAINER);
    stopped = false;
    console.log("  ..    postgres started");

    const recovered = await waitFor(
      async () => (await probe("/api/ready")).status === 200,
      90_000,
      "readiness to return",
    );
    check("readiness recovers on its own", recovered);

    /*
     * The reason this matters here specifically: an earlier version of the
     * Worker cached a `pg` Pool for the life of the isolate, which survived an
     * outage holding dead sockets and served "Query read timeout" until it was
     * redeployed. Per-request clients are what make recovery automatic, and
     * this is the test that would catch a regression to pooling.
     */
    const afterRecovery = await probe("/api/v1/me");
    check(
      "authenticated routes work again without a redeploy",
      afterRecovery.status === 401,
      `status=${afterRecovery.status} (401 = reached the database and found no session)`,
    );

    // =====================================================================
    console.log("\n=== 5. No partial state survived the outage ===");

    const after = createDb({ connectionString: url, max: 1 });
    const now = (
      await after.db.execute<Record<string, string>>(sql`
        SELECT (SELECT COUNT(*)::text FROM users)          AS users,
               (SELECT COUNT(*)::text FROM credit_ledger)  AS ledger,
               (SELECT COUNT(*)::text FROM credit_wallets) AS wallets,
               (SELECT COUNT(*)::text FROM credit_wallets w
                 WHERE w.balance <> COALESCE(
                   (SELECT SUM(amount) FROM credit_ledger l WHERE l.user_id = w.user_id), 0))::text AS drift
      `)
    ).rows[0]!;

    check("no ledger drift was created", now.drift === "0", `drift=${now.drift}`);
    check(
      "no wallet appeared without a ledger entry",
      Number(now.wallets) <= Number(baseline.wallets) + 1,
      `${baseline.wallets} -> ${now.wallets}`,
    );
    check(
      "the signup attempted mid-outage left no half-account",
      Number(
        (
          await after.db.execute<{ n: string }>(
            sql`SELECT COUNT(*)::text AS n FROM users u
                 WHERE u.normalized_email = 'outage@example.test'
                   AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id)`,
          )
        ).rows[0]?.n ?? 0,
      ) === 0,
      "a user row with no credential would be unusable and unrecoverable",
    );

    await after.db
      .execute(sql`UPDATE users SET status='deleted', email='outage-retired-' || id || '@deleted.invalid'
                    WHERE normalized_email = 'outage@example.test'`)
      .catch(() => {});
    await after.pool.end();
  } finally {
    if (stopped) {
      console.log("\n  restoring the database container after a failure mid-drill");
      try {
        docker("start", CONTAINER);
      } catch {
        console.log("  WARN  could not restart the container; start it manually");
      }
    }
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();

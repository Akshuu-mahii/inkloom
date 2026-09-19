/**
 * Production acceptance. Read-only, against the deployed production Worker and
 * the production database.
 *
 *   DATABASE_URL="<production neon url>" pnpm accept:production
 *
 * Deliberately NOT the staging acceptance suite pointed at a different URL.
 * That suite proves controls by exercising them — it signs fixtures up, drives
 * a bucket until it refuses, narrows a limit and restores it — and it refuses
 * to run anywhere but staging for exactly that reason. Production is not a
 * place to create accounts nobody asked for, so every check here either reads a
 * public response or reads the database, and nothing here writes.
 *
 * The consequence is honest and worth stating: this cannot prove the rate
 * limiter refuses, only that its policy is loaded and its events table is being
 * written. The parts that need a real account are covered by signing in as a
 * real person — which is what the launch checklist has an operator do.
 *
 *   PRODUCTION_URL     defaults to https://inkloom.art
 *   ADMIN_PATH         optional; when set, checks the console answers there
 *                      and that /admin does not
 */
import { sql } from "drizzle-orm";
import { createDb } from "@inkloom/db/client";
import { FEATURE_FLAGS, SYSTEM_SETTINGS } from "@inkloom/core/settings";
import { ROLES } from "@inkloom/core/rbac";
import { describeTarget, required } from "./_env";

const BASE = (process.env.PRODUCTION_URL ?? "https://inkloom.art").replace(/\/$/, "");

// Both are keyed registries rather than lists, so the expected count comes from
// the number of keys — and comes from the code, so adding a flag without
// loading it into a database is a failure here rather than a surprise later.
const flagCount = Object.keys(FEATURE_FLAGS).length;
const settingCount = Object.keys(SYSTEM_SETTINGS).length;
const ADMIN_PATH = process.env.ADMIN_PATH?.trim();

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

async function get(path: string, init: RequestInit = {}) {
  const response = await fetch(`${BASE}${path}`, { redirect: "manual", ...init });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

async function edge() {
  section("The deployment answers");

  const health = await get("/api/health");
  check("/api/health is 200", health.status === 200, `got ${health.status}`);

  const ready = await get("/api/ready");
  check(
    "/api/ready reports ready",
    ready.status === 200 && ready.text.includes('"status":"ready"'),
    `${ready.status} ${ready.text.slice(0, 80)}`,
  );

  const home = await get("/");
  check("the home page renders", home.status === 200, `got ${home.status}`);

  // Running the Worker beside the database is a measured decision, not a
  // preference, and it silently stops applying if the placement config is lost.
  const placement = home.headers.get("cf-placement") ?? "";
  check(
    "the Worker runs beside the database",
    placement.startsWith("remote-"),
    placement || "no cf-placement header",
  );

  section("Headers that have to survive the edge");

  const wanted: Array<[string, (value: string | null) => boolean, string]> = [
    ["strict-transport-security", (v) => !!v && /max-age=\d{7,}/.test(v), "max-age >= 1e7"],
    ["content-security-policy", (v) => !!v && v.includes("frame-ancestors"), "frame-ancestors set"],
    ["x-content-type-options", (v) => v === "nosniff", "nosniff"],
    ["referrer-policy", (v) => !!v, "present"],
  ];
  for (const [name, ok, expectation] of wanted) {
    const value = home.headers.get(name);
    check(`${name}: ${expectation}`, ok(value), value ? value.slice(0, 60) : "missing");
  }

  section("Configuration that is wrong in a way nothing else notices");

  // The test sitekey renders a widget that always passes. Shipping it to
  // production leaves every form open while looking completely normal.
  const signup = await get("/signup");
  check("the signup page renders", signup.status === 200, `got ${signup.status}`);
  check(
    "Turnstile uses the production sitekey",
    signup.text.includes("0x4AAAAAAE8XLbusGd7fnZuj"),
    "not the staging or test key",
  );
  check("no Turnstile test key is present", !signup.text.includes("1x00000000000000000000AA"));

  section("Endpoints that must refuse");

  const me = await get("/api/v1/me");
  check("/api/v1/me is 401 when signed out", me.status === 401, `got ${me.status}`);

  const crossOrigin = await get("/api/v1/me", {
    headers: { origin: "https://evil.example" },
  });
  check(
    "a foreign origin is rejected",
    crossOrigin.status === 401 || crossOrigin.status === 403,
    `got ${crossOrigin.status}`,
  );

  const decoy = await get("/admin");
  check("/admin is a 404 decoy", decoy.status === 404, `got ${decoy.status}`);

  if (ADMIN_PATH) {
    const console_ = await get(ADMIN_PATH);
    check(
      "the console answers at its real path",
      console_.status !== 404,
      `got ${console_.status}`,
    );
  } else {
    console.log("  SKIP  console path not checked (set ADMIN_PATH to include it)");
  }
}

async function database() {
  const url = required("DATABASE_URL");
  const { db, pool } = createDb({ connectionString: url, max: 1 });

  try {
    section(`Database — ${describeTarget(url)}`);

    const reference = await db.execute<Record<string, string>>(sql`
      SELECT
        (SELECT COUNT(*)::text FROM roles)                      AS roles,
        (SELECT COUNT(*)::text FROM feature_flags)              AS flags,
        (SELECT COUNT(*)::text FROM system_settings)            AS settings,
        (SELECT COUNT(*)::text FROM users)                      AS users,
        (SELECT COUNT(*)::text FROM access_code_campaigns)      AS campaigns
    `);
    const row = reference.rows[0];

    check(
      `every role is loaded (${ROLES.length})`,
      Number(row.roles) >= ROLES.length,
      `${row.roles} rows`,
    );
    check(
      `every feature flag is loaded (${flagCount})`,
      Number(row.flags) >= flagCount,
      `${row.flags} rows`,
    );
    check(
      `every system setting is loaded (${settingCount})`,
      Number(row.settings) >= settingCount,
      `${row.settings} rows`,
    );
    console.log(`  INFO  users ${row.users}, campaigns ${row.campaigns}`);

    // A production database with no live campaign cannot grant a single credit,
    // and the symptom is a redemption form that rejects every code as invalid.
    const campaigns = await db.execute<Record<string, string>>(sql`
      SELECT COUNT(*)::text AS live FROM access_code_campaigns
       WHERE status = 'active'
         AND (starts_at IS NULL OR starts_at <= now())
         AND (expires_at IS NULL OR expires_at > now())
    `);
    check(
      "at least one campaign is live",
      Number(campaigns.rows[0].live) > 0,
      `${campaigns.rows[0].live} active`,
    );

    // There is no such thing as an acceptable amount of drift here: the ledger
    // is the record and the wallet is a cache of it.
    const drift = await db.execute<Record<string, string>>(sql`
      SELECT COUNT(*)::text AS drifted FROM credit_wallets w
       WHERE w.balance <> COALESCE(
         (SELECT SUM(amount) FROM credit_ledger l WHERE l.user_id = w.user_id), 0)
    `);
    check(
      "no wallet disagrees with the ledger",
      drift.rows[0].drifted === "0",
      `${drift.rows[0].drifted} wallets`,
    );

    const duplicates = await db.execute<Record<string, string>>(sql`
      SELECT COUNT(*)::text AS n FROM (
        SELECT user_id, campaign_id FROM access_code_redemptions
         GROUP BY user_id, campaign_id HAVING COUNT(*) > 1) d
    `);
    check("no code was redeemed twice by one account", duplicates.rows[0].n === "0");

    // A super_admin must exist or nobody can administer anything; more than one
    // at launch means a promotion happened that nobody planned.
    const admins = await db.execute<Record<string, string>>(sql`
      SELECT COUNT(*)::text AS n
        FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE r.name = 'super_admin'
    `);
    check("exactly one super_admin", admins.rows[0].n === "1", `${admins.rows[0].n} found`);

    // The limiter writing nothing looks identical to a limiter that is never
    // reached. This cannot tell them apart on a quiet launch day, so it reports
    // rather than asserts.
    const limiter = await db.execute<Record<string, string>>(sql`
      SELECT COUNT(*)::text AS n FROM rate_limit_events WHERE created_at > now() - interval '24 hours'
    `);
    console.log(`  INFO  rate_limit_events in the last 24h: ${limiter.rows[0].n}`);

    const errors = await db.execute<Record<string, string>>(sql`
      SELECT COUNT(*)::text AS n FROM request_metrics
       WHERE created_at > now() - interval '1 hour' AND status >= 500
    `);
    check("no 5xx in the last hour", errors.rows[0].n === "0", `${errors.rows[0].n} responses`);
  } finally {
    await pool.end();
  }
}

async function main() {
  if (BASE.includes("staging") || BASE.includes("localhost")) {
    console.error(`\n  ${BASE} is not production. Use the staging suites for staging.\n`);
    process.exit(1);
  }

  console.log(`\n  Production acceptance — ${BASE}`);

  await edge();
  await database();

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const failure of failures) console.log(`    - ${failure}`);
    console.log("");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Production acceptance failed to run:", error);
  process.exit(1);
});

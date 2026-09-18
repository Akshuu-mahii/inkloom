/**
 * Capacity measurement against deployed staging.
 *
 *   LOADGEN=https://inkloom-loadgen.<subdomain>.workers.dev \
 *   DATABASE_URL="<staging neon url>" pnpm tsx scripts/capacity-test.ts
 *
 * This machine generates NO load. It seeds accounts, tells a Worker-based
 * generator what to do, waits for the target's telemetry to flush, and compares
 * the two independently. That separation is the whole point: the previous
 * attempt at this ran from a laptop and measured the laptop —
 * `/api/health`, which touches no database, appeared to degrade ninety-fold at
 * 25 concurrent while the server recorded a 372ms maximum and zero errors.
 *
 * TWO NUMBERS, NEVER CONFLATED
 * ----------------------------
 *  - GENERATOR side: wall time per request as a client sees it. Includes the
 *    network, the edge, queueing, everything.
 *  - SERVER side: the target's own `request_metrics`, a latency histogram it
 *    writes itself, plus status counts and ledger integrity.
 *
 * A gap between them is information, not an error: it is queueing outside the
 * application. A client-side failure is NEVER reported as an application
 * failure unless the server's own counters agree.
 *
 * THE GENERATOR SATURATES, AND THAT IS HANDLED
 * --------------------------------------------
 * One invocation plateaus around 70 requests/second no matter what concurrency
 * it is given — latency then rises linearly, which is the signature of a
 * bottleneck in the generator rather than the target. So a run is FANNED OUT
 * across parallel invocations, each holding a small concurrency, and the
 * aggregate is what counts. Measured: 8 invocations x 20 = 556 rps with a worst
 * p95 of 546ms, against 78 rps and 2614ms for a single invocation at 200.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { createDb, type Database } from "@inkloom/db/client";
import { account as accountTable, newId, user as userTable } from "@inkloom/db";
import { percentileFrom } from "@inkloom/core/metrics";
import { describeTarget, required } from "./_env";

const TARGET = process.env.STAGING_URL ?? "https://staging.inkloom.art";
const LOADGEN = required("LOADGEN");
const PASSWORD = "a-perfectly-fine-passphrase-1";

/** Concurrency per generator invocation. Kept low so no invocation self-queues. */
const PER_INVOCATION = 20;
/** Requests each invocation issues. Bounded by the platform's subrequest cap. */
const PER_INVOCATION_TOTAL = 300;
/** How long to wait for the target's telemetry to flush (60s interval + slack). */
const FLUSH_WAIT_MS = 72_000;

interface GenResult {
  requests: number;
  rps: number;
  latency: { p50: number; p95: number; p99: number; max: number; mean: number };
  classes: Record<string, number>;
  status: Record<string, number>;
  colo: string;
  errors: Record<string, number>;
}

async function fanOut(
  scenario: string,
  aggregateConcurrency: number,
  cookies: string[],
): Promise<{ agg: GenResult; invocations: number }> {
  const invocations = Math.max(1, Math.round(aggregateConcurrency / PER_INVOCATION));
  const cookieParam = cookies.length
    ? `&cookies=${cookies.map((c) => encodeURIComponent(c)).join("|")}`
    : "";

  const url = (i: number) =>
    `${LOADGEN}/?scenario=${scenario}&concurrency=${PER_INVOCATION}` +
    `&total=${PER_INVOCATION_TOTAL}&target=${encodeURIComponent(TARGET)}${cookieParam}&lane=${i}`;

  const results = await Promise.all(
    Array.from({ length: invocations }, async (_, i) => {
      const r = await fetch(url(i), { signal: AbortSignal.timeout(300_000) });
      if (!r.ok) throw new Error(`generator returned ${r.status}`);
      return (await r.json()) as GenResult;
    }),
  );

  // Aggregate: sum counts and rps, take the worst percentile across lanes.
  const agg: GenResult = {
    requests: results.reduce((s, r) => s + r.requests, 0),
    rps: Number(results.reduce((s, r) => s + r.rps, 0).toFixed(1)),
    latency: {
      p50: Math.max(...results.map((r) => r.latency.p50)),
      p95: Math.max(...results.map((r) => r.latency.p95)),
      p99: Math.max(...results.map((r) => r.latency.p99)),
      max: Math.max(...results.map((r) => r.latency.max)),
      mean: Number(
        (results.reduce((s, r) => s + r.latency.mean, 0) / results.length).toFixed(1),
      ),
    },
    classes: {},
    status: {},
    colo: results[0]?.colo ?? "unknown",
    errors: {},
  };
  for (const r of results) {
    for (const [k, v] of Object.entries(r.classes)) agg.classes[k] = (agg.classes[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.status)) agg.status[k] = (agg.status[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.errors)) agg.errors[k] = (agg.errors[k] ?? 0) + v;
  }
  return { agg, invocations };
}

interface ServerSnapshot {
  requests: number;
  s2xx: number;
  s4xx: number;
  s429: number;
  s5xx: number;
  durationTotal: number;
  durationMax: number;
  buckets: Record<string, number>;
}

async function serverSnapshot(db: Database): Promise<ServerSnapshot> {
  const row = (
    await db.execute<Record<string, string>>(sql`
      SELECT COALESCE(SUM(requests),0)::text          AS requests,
             COALESCE(SUM(status_2xx),0)::text        AS s2xx,
             COALESCE(SUM(status_4xx),0)::text        AS s4xx,
             COALESCE(SUM(status_429),0)::text        AS s429,
             COALESCE(SUM(status_5xx),0)::text        AS s5xx,
             COALESCE(SUM(duration_ms_total),0)::text AS dtotal,
             COALESCE(MAX(duration_ms_max),0)::text   AS dmax
        FROM request_metrics
    `)
  ).rows[0]!;

  const buckets = (
    await db.execute<{ bucket: string; n: string }>(sql`
      SELECT key AS bucket, SUM(value::bigint)::text AS n
        FROM request_metrics, jsonb_each_text(latency_buckets)
       GROUP BY key
    `)
  ).rows;

  return {
    requests: Number(row.requests),
    s2xx: Number(row.s2xx),
    s4xx: Number(row.s4xx),
    s429: Number(row.s429),
    s5xx: Number(row.s5xx),
    durationTotal: Number(row.dtotal),
    durationMax: Number(row.dmax),
    buckets: Object.fromEntries(buckets.map((b) => [b.bucket, Number(b.n)])),
  };
}

function diff(before: ServerSnapshot, after: ServerSnapshot) {
  const buckets: Record<string, number> = {};
  for (const key of new Set([...Object.keys(before.buckets), ...Object.keys(after.buckets)])) {
    const d = (after.buckets[key] ?? 0) - (before.buckets[key] ?? 0);
    if (d > 0) buckets[key] = d;
  }
  const requests = after.requests - before.requests;
  const durationTotal = after.durationTotal - before.durationTotal;
  return {
    requests,
    s2xx: after.s2xx - before.s2xx,
    s4xx: after.s4xx - before.s4xx,
    s429: after.s429 - before.s429,
    s5xx: after.s5xx - before.s5xx,
    mean: requests > 0 ? Math.round(durationTotal / requests) : 0,
    max: after.durationMax,
    p50: percentileFrom(buckets, 0.5),
    p95: percentileFrom(buckets, 0.95),
    p99: percentileFrom(buckets, 0.99),
    buckets,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function seedSession(db: Database, label: string) {
  const email = `cap-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const userId = newId("usr");
  await db.insert(userTable).values({
    id: userId,
    email,
    name: `Cap ${label}`,
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

  const login = await fetch(`${TARGET}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: TARGET },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
  return { email, userId, cookie };
}

async function main() {
  const url = required("DATABASE_URL");
  const { db, pool } = createDb({ connectionString: url, max: 3 });
  console.log(`\n  target: ${TARGET}`);
  console.log(`  generator: ${LOADGEN}`);
  console.log(`  database: ${describeTarget(url)}\n`);

  const created: string[] = [];
  const report: string[] = [];

  try {
    // =====================================================================
    console.log("=== Seeding sessions for authenticated load ===");
    const sessions = await Promise.all(
      Array.from({ length: 10 }, (_, i) => seedSession(db, `s${i}`)),
    );
    for (const s of sessions) created.push(s.userId);
    const cookies = sessions.map((s) => s.cookie).filter(Boolean);
    console.log(`  ..    ${cookies.length}/10 sessions established`);

    const startIntegrity = (
      await db.execute<{ drift: string }>(sql`
        SELECT COUNT(*)::text AS drift FROM credit_wallets w
         WHERE w.balance <> COALESCE(
           (SELECT SUM(amount) FROM credit_ledger l WHERE l.user_id = w.user_id), 0)
      `)
    ).rows[0]!;
    console.log(`  ..    ledger drift before: ${startIntegrity.drift}`);

    // =====================================================================
    const ramp: Array<[string, number[]]> = [
      ["health", [25, 100, 300, 500]],
      ["browse", [25, 50, 100, 200, 500]],
      ["me", [25, 50, 100, 200]],
      ["mixed", [25, 50, 100, 200, 500]],
    ];

    for (const [scenario, levels] of ramp) {
      console.log(`\n=== Scenario: ${scenario} ===`);
      for (const level of levels) {
        const before = await serverSnapshot(db);
        const { agg, invocations } = await fanOut(scenario, level, cookies);

        console.log(
          `  c=${String(level).padStart(3)} (${invocations}x${PER_INVOCATION})  ` +
            `GEN rps=${String(agg.rps).padStart(6)} p50=${String(agg.latency.p50).padStart(5)} ` +
            `p95=${String(agg.latency.p95).padStart(5)} p99=${String(agg.latency.p99).padStart(5)} ` +
            `max=${String(agg.latency.max).padStart(5)}  ` +
            `2xx=${agg.classes["2xx"] ?? 0} 3xx=${agg.classes["3xx"] ?? 0} ` +
            `4xx=${agg.classes["4xx"] ?? 0} 429=${agg.classes["429"] ?? 0} ` +
            `5xx=${agg.classes["5xx"] ?? 0} transport=${agg.classes.transport ?? 0}`,
        );
        if (Object.keys(agg.errors).length) {
          console.log(`        generator transport errors: ${JSON.stringify(agg.errors)}`);
        }

        // Wait for the target to flush its own counters, then compare.
        await wait(FLUSH_WAIT_MS);
        const after = await serverSnapshot(db);
        const d = diff(before, after);

        console.log(
          `        SRV req=${d.requests} mean=${d.mean}ms p50=${d.p50 ?? "-"} ` +
            `p95=${d.p95 ?? "-"} p99=${d.p99 ?? "-"} max=${d.max}ms  ` +
            `2xx=${d.s2xx} 4xx=${d.s4xx} 429=${d.s429} 5xx=${d.s5xx}`,
        );

        report.push(
          `${scenario},${level},${agg.rps},${agg.latency.p50},${agg.latency.p95},` +
            `${agg.latency.p99},${agg.classes["5xx"] ?? 0},${agg.classes["429"] ?? 0},` +
            `${d.requests},${d.mean},${d.p95 ?? ""},${d.s5xx},${d.s429}`,
        );

        if ((d.s5xx ?? 0) > 0) {
          console.log(
            `        !! the SERVER recorded ${d.s5xx} 5xx — this is an application failure,` +
              " not a client one",
          );
        }
      }
    }

    // =====================================================================
    console.log("\n=== Thundering herd: one code, many simultaneous redemptions ===");

    /*
     * Latency is not the interesting output here. The question is whether a
     * burst of identical redemptions can produce two grants for one code — the
     * failure that quietly creates money.
     */
    const herdSessions = await Promise.all(
      Array.from({ length: 30 }, (_, i) => seedSession(db, `herd${i}`)),
    );
    for (const s of herdSessions) created.push(s.userId);
    const herdCookies = herdSessions.map((s) => s.cookie).filter(Boolean);

    const beforeHerd = await serverSnapshot(db);
    const herd = await fanOut("redeem", 200, herdCookies);
    console.log(
      `  GEN rps=${herd.agg.rps} p95=${herd.agg.latency.p95}ms ` +
        `2xx=${herd.agg.classes["2xx"] ?? 0} 4xx=${herd.agg.classes["4xx"] ?? 0} ` +
        `429=${herd.agg.classes["429"] ?? 0} 5xx=${herd.agg.classes["5xx"] ?? 0}`,
    );

    const integrity = (
      await db.execute<Record<string, string>>(sql`
        SELECT
          (SELECT COUNT(*)::text FROM credit_wallets w
            WHERE w.balance <> COALESCE(
              (SELECT SUM(amount) FROM credit_ledger l WHERE l.user_id = w.user_id), 0)) AS drift,
          (SELECT COUNT(*)::text FROM (
             SELECT user_id FROM access_code_redemptions
              GROUP BY user_id, campaign_id HAVING COUNT(*) > 1) dup)                    AS duplicate_redemptions,
          (SELECT COUNT(*)::text FROM (
             SELECT idempotency_key FROM credit_ledger
              GROUP BY idempotency_key HAVING COUNT(*) > 1) dupk)                        AS duplicate_ledger_keys
      `)
    ).rows[0]!;

    console.log(`  ledger drift:            ${integrity.drift}`);
    console.log(`  duplicate redemptions:   ${integrity.duplicate_redemptions}`);
    console.log(`  duplicate ledger keys:   ${integrity.duplicate_ledger_keys}`);

    await wait(FLUSH_WAIT_MS);
    const herdServer = diff(beforeHerd, await serverSnapshot(db));
    console.log(
      `  SRV req=${herdServer.requests} p95=${herdServer.p95 ?? "-"}ms ` +
        `5xx=${herdServer.s5xx} 429=${herdServer.s429}`,
    );

    // =====================================================================
    console.log("\n=== CSV (scenario,c,gen_rps,gen_p50,gen_p95,gen_p99,gen_5xx,gen_429,srv_req,srv_mean,srv_p95,srv_5xx,srv_429) ===");
    for (const line of report) console.log(line);
  } finally {
    for (const id of created) {
      await db.execute(sql`DELETE FROM accounts WHERE user_id = ${id}`).catch(() => {});
      await db.execute(sql`DELETE FROM sessions WHERE user_id = ${id}`).catch(() => {});
      await db
        .execute(sql`UPDATE users SET status='deleted', anonymized_at=now(),
                       email='cap-retired-' || id || '@deleted.invalid'
                     WHERE id = ${id}`)
        .catch(() => {});
    }
    console.log(`\n  retired ${created.length} load accounts`);
    await pool.end();
  }
}

void main();

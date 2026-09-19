/**
 * Scheduled-job acceptance, against a deployed environment.
 *
 *   DATABASE_URL="<neon url>" pnpm tsx scripts/cron-acceptance.ts [staging|production]
 *
 * Three separate questions, easy to conflate:
 *
 *   1. Is the trigger CONFIGURED on the deployed Worker?
 *   2. Has it ever actually FIRED in production-like conditions?
 *   3. When it fires, does it leave a durable, queryable, alertable record?
 *
 * A green answer to (1) and (3) with no answer to (2) is how a retention
 * promise goes unenforced for months: the code is right, the record works, and
 * nothing ever ran it.
 */
import { sql } from "drizzle-orm";
import { createDb } from "@inkloom/db/client";
import {
  jobHealth,
  recordJobRun,
  RETENTION_JOB,
  RETENTION_MAX_AGE_HOURS,
  runRetentionSweep,
} from "@inkloom/core/retention";
import { silentLogger } from "@inkloom/core/logger";
import { describeTarget, required } from "./_env";
import path from "node:path";
import { wranglerEnv } from "./_wrangler";

let passed = 0;
let failed = 0;
let pending = 0;

const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
};

/**
 * A third outcome, for a check that is not yet answerable.
 *
 * "The cron fired at its configured minute" cannot be true in an environment
 * deployed after today's occurrence of that minute — not because anything is
 * wrong, but because the opportunity has not arrived. Reporting that as FAIL
 * teaches an operator that red sometimes means "wait", and a gate whose red is
 * sometimes fine is a gate nobody reads.
 *
 * It does not count as a pass either. The question stays open, and the run says
 * so, so the answer gets collected rather than assumed.
 */
const notYet = (label: string, detail = "") => {
  console.log(`  WAIT  ${label}${detail ? `  ${detail}` : ""}`);
  pending += 1;
};

/** The most recent UTC time matching `hour:minute`, at or before `now`. */
export function lastOccurrence(hour: number, minute: number, now = new Date()): Date {
  const at = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0),
  );
  if (at > now) at.setUTCDate(at.getUTCDate() - 1);
  return at;
}

async function main() {
  const url = required("DATABASE_URL");
  const targetEnv = process.argv[2] ?? "staging";
  const { db, pool } = createDb({ connectionString: url, max: 1 });
  console.log(`\n  ${describeTarget(url)}\n`);

  try {
    // =====================================================================
    console.log("=== 1. The trigger is configured on the deployed Worker ===");

    /*
     * Read the config rather than ask wrangler.
     *
     * `wrangler triggers deploy` is not read-only in every version and
     * `deployments status` does not report the schedule at all, so neither is a
     * safe probe. The declaration is what gets deployed, and section 2 below is
     * the empirical proof that it actually fires — which is the stronger
     * evidence anyway.
     */
    /*
     * Parsed, not sliced out of the text.
     *
     * This read the characters between `"staging"` and `"production"` and
     * regexed a cron out of them. It worked, and it meant the check silently
     * described staging no matter which environment was being accepted — so
     * pointing it at production would have reported staging's schedule as
     * production's proof.
     */
    const env = wranglerEnv(targetEnv);
    const cron = env?.triggers?.crons?.[0] ?? "";

    check(
      `the ${targetEnv} environment declares a cron schedule`,
      cron.length > 0,
      `cron="${cron}"`,
    );
    check(
      "and cron triggers are declared per environment, not inherited",
      Array.isArray(env?.triggers?.crons),
      "Cloudflare does not inherit them from the top-level block",
    );

    // =====================================================================
    console.log("\n=== 2. It has actually fired ===");

    /*
     * `provider_metrics.captured_at` is written only by the scheduled handler,
     * so its timestamps are a fingerprint of real cron executions. Matching
     * them against the configured minute is what distinguishes "the cron ran"
     * from "someone ran the sweep by hand".
     */
    const fired = await db.execute<{ captured_at: string; hh: string; mm: string }>(sql`
      SELECT captured_at::text AS captured_at,
             to_char(captured_at, 'HH24') AS hh,
             to_char(captured_at, 'MI')   AS mm
        FROM provider_metrics
       ORDER BY captured_at DESC
       LIMIT 5
    `);

    for (const row of fired.rows) {
      console.log(`  ..    provider_metrics captured at ${row.captured_at}`);
    }
    check(
      "the scheduled handler has run at least once",
      fired.rows.length > 0,
      `${fired.rows.length} capture(s) recorded`,
    );
    /*
     * The configured minute, read from the cron rather than written out twice.
     * The label used to say "03:20 UTC" in prose beside a matcher that could
     * drift away from it without the sentence changing.
     */
    const [cronMinute, cronHour] = cron.split(" ").map(Number);
    const at = `${String(cronHour).padStart(2, "0")}:${String(cronMinute).padStart(2, "0")} UTC`;
    const ranOnSchedule = fired.rows.some(
      (r) =>
        Number(r.hh) === cronHour && Number(r.mm) >= cronMinute && Number(r.mm) <= cronMinute + 5,
    );

    /*
     * Has the schedule even come round since this environment existed?
     *
     * A Worker deployed at noon cannot have fired an 03:20 trigger today, and
     * calling that a failure is how a gate earns a reputation for crying wolf.
     *
     * NOT `drizzle.__drizzle_migrations.created_at`, which is the obvious
     * choice and is wrong: Drizzle stores the JOURNAL's `when` value there —
     * the moment the migration file was authored — so it is byte-identical in
     * every environment and older than all of them. Production reported its age
     * as ten days when it was four hours old, and the check duly failed for a
     * cron that had never had a chance to run.
     *
     * `roles` is written by the reference seed, immediately after migrations,
     * with a real `now()`. It is the earliest row this environment created
     * rather than inherited, and it predates the Worker being deployed, so this
     * still errs toward demanding the proof.
     */
    const seeded = await db.execute<{ at: string | null }>(sql`
      SELECT to_char(MIN(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
        FROM roles
    `);
    const existedSince = seeded.rows[0]?.at ? new Date(seeded.rows[0].at) : null;
    const due = lastOccurrence(cronHour, cronMinute);
    const hadTheChance = !existedSince || due > existedSince;

    if (ranOnSchedule) {
      check(
        `and it ran at the configured minute (${at}), not by hand`,
        true,
        `newest at ${fired.rows[0].hh}:${fired.rows[0].mm} UTC`,
      );
    } else if (!hadTheChance) {
      notYet(
        `it has not yet had a scheduled run at ${at}`,
        `environment exists since ${existedSince?.toISOString().slice(0, 16)}Z; next due ${at}`,
      );
    } else {
      check(
        `and it ran at the configured minute (${at}), not by hand`,
        false,
        fired.rows[0]
          ? `newest at ${fired.rows[0].hh}:${fired.rows[0].mm} UTC — ${at} has come round since deploy`
          : "no scheduled capture at all",
      );
    }

    // =====================================================================
    console.log("\n=== 3. A run leaves a durable, queryable record ===");

    const before = await jobHealth(db);
    console.log(
      `  ..    before: healthy=${before.healthy} last=${before.lastRunAt?.toISOString() ?? "never"}`,
    );

    const result = await runRetentionSweep(db, silentLogger);
    const row = (
      await db.execute<Record<string, string>>(sql`
        SELECT status, duration_ms::text AS duration_ms, removed::text AS removed,
               started_at::text AS started_at, finished_at::text AS finished_at,
               jsonb_array_length(steps) ::text AS step_count
          FROM job_runs WHERE job = ${RETENTION_JOB}
         ORDER BY finished_at DESC LIMIT 1
      `)
    ).rows[0]!;

    check("a run records its status", !!row.status, `status=${row.status}`);
    check("a run records when it started", !!row.started_at);
    check("a run records when it finished", !!row.finished_at);
    check("a run records its duration", Number(row.duration_ms) >= 0, `${row.duration_ms}ms`);
    check("a run records rows removed", Number(row.removed) >= 0, `removed=${row.removed}`);
    check(
      "a run records per-step detail",
      Number(row.step_count) === result.steps.length,
      `steps=${row.step_count}`,
    );

    // =====================================================================
    console.log("\n=== 4. Staleness is visible and alertable ===");

    const healthy = await jobHealth(db);
    check("a fresh run reads as healthy", healthy.healthy, `ageHours=${healthy.ageHours}`);

    /*
     * Simulate the alarm condition without waiting a day: age the newest row
     * past the window, confirm the signal flips, then remove the synthetic row.
     * `job_runs` is ordinary operational data — not append-only — so this is a
     * legitimate write rather than a weakened protection.
     */
    const stale = new Date(Date.now() - (RETENTION_MAX_AGE_HOURS + 3) * 3_600_000);
    await recordJobRun(db, {
      job: "cron_acceptance_probe",
      startedAt: stale,
      finishedAt: stale,
      status: "ok",
      durationMs: 1,
    });
    const staleHealth = await jobHealth(db, "cron_acceptance_probe");
    check(
      "a run older than the window reads as UNHEALTHY",
      !staleHealth.healthy,
      `ageHours=${staleHealth.ageHours}`,
    );

    await recordJobRun(db, {
      job: "cron_acceptance_probe_partial",
      startedAt: new Date(),
      finishedAt: new Date(),
      status: "partial",
      durationMs: 1,
    });
    check(
      "a PARTIAL run reads as unhealthy, so a nightly failing step cannot hide",
      !(await jobHealth(db, "cron_acceptance_probe_partial")).healthy,
    );

    const neverRan = await jobHealth(db, "a_job_that_has_never_run");
    check(
      "a job with no runs at all reads as unhealthy",
      !neverRan.healthy && neverRan.lastRunAt === null,
    );

    await db.execute(sql`DELETE FROM job_runs WHERE job LIKE 'cron_acceptance_probe%'`);

    // =====================================================================
    console.log("\n=== 5. The signal reaches an operator ===");

    /*
     * The admin overview folds job health into `operations.status`, so a stale
     * retention job degrades the page an operator already watches. Verified
     * here at the data layer because reaching the console needs the owner
     * account, which a script must not hold.
     */
    const degrades = await db.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n FROM job_runs WHERE job = ${RETENTION_JOB}
    `);
    check(
      "the overview has a job_runs row to report",
      Number(degrades.rows[0]?.n ?? 0) > 0,
      `rows=${degrades.rows[0]?.n}`,
    );

    const retention = await db.execute<Record<string, string>>(sql`
      SELECT
        (SELECT COUNT(*)::text FROM security_events
          WHERE created_at < now() - interval '365 days')   AS stale_security,
        (SELECT COUNT(*)::text FROM analytics_events
          WHERE created_at < now() - interval '425 days')   AS stale_analytics,
        (SELECT COUNT(*)::text FROM data_export_requests
          WHERE payload IS NOT NULL AND expires_at < now()) AS stale_exports
    `);
    const r = retention.rows[0]!;
    check(
      "no security event is past its retention period",
      r.stale_security === "0",
      `n=${r.stale_security}`,
    );
    check(
      "no analytics event is past its retention period",
      r.stale_analytics === "0",
      `n=${r.stale_analytics}`,
    );
    check("no expired export payload survives", r.stale_exports === "0", `n=${r.stale_exports}`);
  } finally {
    await pool.end();
  }

  const waiting = pending > 0 ? `, ${pending} not yet verifiable` : "";
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed${waiting} ===`);
  if (pending > 0) {
    console.log("    Re-run after the next scheduled execution to close these.\n");
  } else {
    console.log("");
  }

  // Pending does not fail the run. It is an open question, not a defect, and a
  // gate that goes red for "come back tomorrow" stops being read.
  process.exit(failed === 0 ? 0 : 1);
}

// Only when run as a command. Exported helpers are imported by tests, and a
// module that runs its whole acceptance suite on import cannot be tested.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  void main();
}

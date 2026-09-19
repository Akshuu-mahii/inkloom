/**
 * The final integrity read for the staging gate.
 *
 *   DATABASE_URL="<staging neon url>" pnpm tsx scripts/gate-summary.ts
 *
 * Read-only. Every number here is one the acceptance gate names explicitly, so
 * it can be re-run at any time to confirm the gate still holds rather than
 * trusting a report written once.
 */
import { sql } from "drizzle-orm";
import { createDb } from "@inkloom/db/client";
import {
  BACKUP_JOB,
  JOB_MAX_AGE_HOURS,
  jobHealth,
  RESTORE_TEST_JOB,
  RETENTION_JOB,
} from "@inkloom/core/retention";
import { describeTarget, required } from "./_env";

/** Thrown to roll a probe transaction back; never an error worth reporting. */
class RollbackProbe extends Error {}

async function main() {
  const url = required("DATABASE_URL");
  const { db, pool } = createDb({ connectionString: url, max: 1 });
  console.log(`\n  ${describeTarget(url)}\n`);

  const row = (
    await db.execute<Record<string, string>>(sql`
      SELECT
        (SELECT COUNT(*)::text FROM credit_wallets w
          WHERE w.balance <> COALESCE(
            (SELECT SUM(amount) FROM credit_ledger l WHERE l.user_id = w.user_id), 0)) AS ledger_drift,
        (SELECT COUNT(*)::text FROM (
           SELECT user_id, campaign_id FROM access_code_redemptions
            GROUP BY user_id, campaign_id HAVING COUNT(*) > 1) d)                      AS duplicate_redemptions,
        (SELECT COUNT(*)::text FROM (
           SELECT idempotency_key FROM credit_ledger
            GROUP BY idempotency_key HAVING COUNT(*) > 1) d)                           AS duplicate_ledger_keys,
        (SELECT COALESCE(SUM(status_5xx),0)::text FROM request_metrics)                AS five_xx_all_time,
        (SELECT COALESCE(SUM(requests),0)::text FROM request_metrics)                  AS requests_all_time,
        (SELECT COUNT(*)::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal)                                                    AS append_only_triggers,
        (SELECT COUNT(*)::text FROM drizzle.__drizzle_migrations)                      AS migrations_applied,
        (SELECT COUNT(*)::text FROM users WHERE status = 'active')                      AS active_users,
        (SELECT COUNT(*)::text FROM users WHERE anonymized_at IS NOT NULL)              AS erased_accounts,
        (SELECT COUNT(*)::text FROM users
          WHERE anonymized_at IS NOT NULL AND normalized_email NOT LIKE '%@deleted.invalid'
            AND normalized_email NOT LIKE '%@example.invalid')                          AS erased_with_address,
        (SELECT COUNT(*)::text FROM accounts a JOIN users u ON u.id = a.user_id
          WHERE u.anonymized_at IS NOT NULL)                                            AS erased_with_credentials,
        (SELECT COUNT(*)::text FROM sessions WHERE revoked_at IS NULL AND expires_at > now()) AS live_sessions,
        (SELECT COUNT(*)::text FROM security_events WHERE type = 'rate_limit_exceeded')  AS rate_limit_events,
        (SELECT COUNT(*)::text FROM rate_limit_events WHERE blocked = true)              AS buckets_that_blocked,
        (SELECT COUNT(DISTINCT bucket)::text FROM rate_limit_events)                     AS buckets_exercised,
        (SELECT value::text FROM system_settings WHERE key = 'rate_limit_overrides')     AS overrides
    `)
  ).rows[0]!;

  const gate: Array<[string, string, boolean]> = [
    ["ledger drift", row.ledger_drift, row.ledger_drift === "0"],
    ["duplicate redemptions", row.duplicate_redemptions, row.duplicate_redemptions === "0"],
    ["duplicate ledger keys", row.duplicate_ledger_keys, row.duplicate_ledger_keys === "0"],
    ["5xx all time", row.five_xx_all_time, row.five_xx_all_time === "0"],
    ["append-only triggers", row.append_only_triggers, row.append_only_triggers === "2"],
    [
      "erased accounts keeping an address",
      row.erased_with_address,
      row.erased_with_address === "0",
    ],
    [
      "erased accounts keeping credentials",
      row.erased_with_credentials,
      row.erased_with_credentials === "0",
    ],
    ["rate-limit overrides restored", row.overrides ?? "null", (row.overrides ?? "{}") === "{}"],
  ];

  console.log("  GATE INVARIANTS");
  for (const [label, value, ok] of gate) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(38)} ${value}`);
  }

  console.log("\n  CONTEXT");
  for (const [k, v] of [
    ["requests recorded all time", row.requests_all_time],
    ["migrations applied", row.migrations_applied],
    ["active users", row.active_users],
    ["erased accounts", row.erased_accounts],
    ["live sessions", row.live_sessions],
    ["rate-limit refusals recorded", row.rate_limit_events],
    ["counter rows that blocked", row.buckets_that_blocked],
    ["distinct buckets exercised", row.buckets_exercised],
  ] as Array<[string, string]>) {
    console.log(`  ..    ${k.padEnd(38)} ${v}`);
  }

  /*
   * Scheduled jobs, all read the same way.
   *
   * Retention keeps the published privacy promises, the backup is the only
   * thing between a bad hour and permanent loss, and the restore test is what
   * stops the backup quietly becoming unusable. All three fail by not running,
   * so all three are judged on the age of their newest row rather than on an
   * error someone has to remember to raise.
   */
  console.log("\n  SCHEDULED JOBS");
  let unhealthyJobs = 0;
  for (const job of [RETENTION_JOB, BACKUP_JOB, RESTORE_TEST_JOB]) {
    const h = await jobHealth(db, job, JOB_MAX_AGE_HOURS[job]);
    if (!h.healthy) unhealthyJobs += 1;
    console.log(
      `  ${h.healthy ? "PASS" : "FAIL"}  ${job.padEnd(20)} status=${String(h.lastStatus).padEnd(8)}` +
        ` age=${h.ageHours === null ? "never run" : `${h.ageHours}h`}` +
        ` (allowed ${JOB_MAX_AGE_HOURS[job]}h)`,
    );
  }

  /*
   * Behaviour, not presence: the only trustworthy check on an append-only table.
   *
   * INSIDE A TRANSACTION THAT ALWAYS ROLLS BACK. The probe is an UPDATE, and
   * the whole point is that it should be refused — but the case worth checking
   * is precisely the one where the trigger is MISSING, and there the statement
   * succeeds and rewrites every row of the ledger and the audit log. A check
   * that damages the thing it is checking, in exactly the situation it exists
   * to detect, is not a check. This was written for staging, where that was a
   * shrug; it runs against production now.
   */
  for (const table of ["audit_events", "credit_ledger"]) {
    let refused = false;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`UPDATE ${table} SET id = id`));
        // Never commit, whatever happened above.
        throw new RollbackProbe();
      });
    } catch (error) {
      if (error instanceof RollbackProbe) {
        refused = false; // The UPDATE went through; only the rollback stopped it.
      } else {
        refused = /append-only/i.test(String((error as { cause?: unknown })?.cause ?? error));
      }
    }
    console.log(`  ${refused ? "PASS" : "FAIL"}  ${table} refuses an UPDATE`);
    if (!refused) unhealthyJobs += 1;
  }

  const failures = gate.filter(([, , ok]) => !ok).length + unhealthyJobs;
  console.log(
    `\n  ${failures === 0 ? "ALL GATE INVARIANTS HOLD" : `${failures} INVARIANT(S) FAILING`}\n`,
  );

  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

void main();

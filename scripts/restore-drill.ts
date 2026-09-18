/**
 * Backup and restore drill, against real staging infrastructure.
 *
 *   DATABASE_URL="<staging neon url>" pnpm tsx scripts/restore-drill.ts
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * This is a genuine backup/restore drill: a logical backup is taken, the live
 * database is then deliberately changed, the backup is restored into a separate
 * database on the same Neon project, and the recovered contents are checked
 * against what was recorded before the change.
 *
 * It is NOT a Neon point-in-time restore. PITR creates a branch through Neon's
 * control plane, which needs an API key this environment does not have. The
 * difference matters and is not glossed over: PITR can recover to any second
 * within the retention window with no prior action, whereas this procedure can
 * only recover to a backup someone actually took. Both are exercised by the
 * same verification below; only the acquisition differs.
 *
 * SAFETY
 * ------
 * The live database is never restored over. The recovery target is a brand new
 * database, created for the drill and dropped at the end. Nothing here disables
 * a trigger or a constraint — in fact the whole point is to prove they come
 * back.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb, type Database } from "@inkloom/db/client";
import { newId } from "@inkloom/db";
import { describeTarget, insideContainer, required } from "./_env";

const RECOVERY_DB = "recovery_drill";
/** Runs pg_dump/psql/pg_restore inside the local Postgres container. */
const PG_CONTAINER = process.env.PG_CONTAINER ?? "inkloom-postgres";

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
};

function pg(args: string[], input?: string): string {
  return execFileSync("docker", ["exec", "-i", PG_CONTAINER, ...args], {
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Swap the database name in a Postgres URL, keeping every other parameter. */
/** A database we can connect to in order to CREATE/DROP another one. */
function maintenanceDb(url: string): string {
  return /neon\.tech/.test(new URL(url).hostname) ? "neondb" : "postgres";
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function main() {
  const url = required("DATABASE_URL");
  if (!url.includes("staging") && !/neon\.tech/.test(url) && !url.includes("127.0.0.1")) {
    console.error("\n  Refusing: point this at staging or a local database.\n");
    process.exit(1);
  }

  const { db, pool } = createDb({ connectionString: url, max: 2 });
  const work = mkdtempSync(join(tmpdir(), "inkloom-restore-"));
  const dumpPath = "/tmp/inkloom-restore-drill.sql";

  console.log(`\n  Source: ${describeTarget(url)}`);
  console.log(`  Recovery target: ${RECOVERY_DB} (temporary, dropped at the end)\n`);

  const marker = newId("usr");
  const markerEmail = `restore-drill-${marker.slice(-8).toLowerCase()}@example.test`;
  /** Unique per run: see the note where it is written. */
  const postBackupMarker = `drill: written after the backup ${marker}`;

  try {
    // =====================================================================
    console.log("=== 1. Put known state into staging ===");

    const walletId = newId("wal");
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO users (id, name, email, email_verified, role, status)
        VALUES (${marker}, 'Restore Drill', ${markerEmail}, true, 'user', 'active')
      `);
      await tx.execute(sql`
        INSERT INTO credit_wallets (id, user_id, balance)
        VALUES (${walletId}, ${marker}, 140)
      `);
      /*
       * Three entries summing to the wallet balance, with a correct running
       * `balance_after` on each — so what has to survive the round trip is not
       * just the rows but the invariant the reconciler checks.
       */
      let running = 0;
      for (const [amount, reason] of [
        [100, "restore drill: opening grant"],
        [75, "restore drill: second grant"],
        [-35, "restore drill: deduction"],
      ] as const) {
        running += amount;
        await tx.execute(sql`
          INSERT INTO credit_ledger
            (id, user_id, wallet_id, amount, type, balance_after, reference_type,
             idempotency_key, actor_type, actor_id, reason)
          VALUES (${newId("led")}, ${marker}, ${walletId}, ${amount},
                  ${amount > 0 ? "ADMIN_GRANT" : "ADMIN_DEDUCTION"}, ${running},
                  'admin_adjustment', ${`drill-${newId("led")}`}, 'system', NULL, ${reason})
        `);
      }
      await tx.execute(sql`
        INSERT INTO audit_events (id, action, actor_type, actor_id, target_type, target_id, reason, metadata)
        VALUES (${newId("aud")}, 'drill.restore.marker', 'system', NULL, 'user', ${marker},
                'Known state for the restore drill', '{}'::jsonb)
      `);
    });

    const expected = (
      await db.execute<Record<string, string>>(sql`
        SELECT (SELECT COUNT(*)::text FROM users)                                  AS users,
               (SELECT COUNT(*)::text FROM credit_ledger)                          AS ledger,
               (SELECT COUNT(*)::text FROM audit_events)                           AS audit,
               (SELECT balance::text FROM credit_wallets WHERE user_id = ${marker}) AS marker_balance,
               (SELECT COALESCE(SUM(amount),0)::text FROM credit_ledger WHERE user_id = ${marker}) AS marker_ledger,
               now()::text                                                          AS at
      `)
    ).rows[0]!;

    console.log(
      `  ..    recorded: users=${expected.users} ledger=${expected.ledger} audit=${expected.audit}` +
        ` marker_balance=${expected.marker_balance}`,
    );
    check(
      "the marker account is internally consistent",
      expected.marker_balance === expected.marker_ledger,
      `wallet=${expected.marker_balance} ledger=${expected.marker_ledger}`,
    );

    // =====================================================================
    console.log("\n=== 2. Take the backup (this is the recovery point) ===");

    const dumpStart = Date.now();
    pg([
      "pg_dump",
      insideContainer(url),
      "--no-owner",
      "--no-privileges",
      "--format=plain",
      "--file",
      dumpPath,
    ]);
    const dumpMs = Date.now() - dumpStart;
    const sizeBytes = Number(pg(["stat", "-c", "%s", dumpPath]).trim());
    console.log(
      `  ..    backup took ${(dumpMs / 1000).toFixed(1)}s, ${(sizeBytes / 1024 / 1024).toFixed(2)} MB`,
    );
    check("the backup was produced", sizeBytes > 0);

    // =====================================================================
    console.log("\n=== 3. Change the data AFTER the recovery point ===");

    const damage = newId("usr");
    await db.execute(sql`
      INSERT INTO users (id, name, email, email_verified, role, status)
      VALUES (${damage}, 'After The Backup', ${`after-${damage.slice(-8).toLowerCase()}@example.test`},
              true, 'user', 'active')
    `);
    /*
     * A ledger entry the restore must NOT contain, and a wallet that moves with
     * it — the exact shape of "we restored and lost the last hour".
     *
     * The reason string is UNIQUE PER RUN, and that is load-bearing. It used to
     * be the fixed text "drill: written after the backup", which worked exactly
     * once: `credit_ledger` is append-only, so the row cannot be cleaned up,
     * and every later run's backup therefore CONTAINED the previous run's
     * marker. The check then reported that post-backup data had survived the
     * restore, which was true of some other run's data and said nothing about
     * this one.
     */
    await db.execute(sql`
      INSERT INTO credit_ledger
        (id, user_id, wallet_id, amount, type, balance_after, reference_type,
         idempotency_key, actor_type, actor_id, reason)
      VALUES (${newId("led")}, ${marker}, ${walletId}, 999, 'ADMIN_GRANT', 1139,
              'admin_adjustment', ${`drill-${newId("led")}`}, 'system', NULL,
              ${postBackupMarker})
    `);
    await db.execute(sql`UPDATE credit_wallets SET balance = 1139 WHERE user_id = ${marker}`);

    const damaged = (
      await db.execute<Record<string, string>>(sql`
        SELECT (SELECT COUNT(*)::text FROM users) AS users,
               (SELECT balance::text FROM credit_wallets WHERE user_id = ${marker}) AS marker_balance
      `)
    ).rows[0]!;
    console.log(
      `  ..    live is now: users=${damaged.users} marker_balance=${damaged.marker_balance}` +
        ` (was ${expected.marker_balance})`,
    );
    check("the live database genuinely diverged", damaged.marker_balance !== expected.marker_balance);

    // =====================================================================
    console.log("\n=== 4. Restore into a separate recovery target ===");

    const adminUrl = insideContainer(withDatabase(url, maintenanceDb(url)));
    pg(["psql", adminUrl, "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS ${RECOVERY_DB}`]);
    pg(["psql", adminUrl, "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${RECOVERY_DB}`]);

    const recoveryUrl = withDatabase(url, RECOVERY_DB);
    const recoveryUrlInside = insideContainer(recoveryUrl);
    const restoreStart = Date.now();
    pg(["psql", recoveryUrlInside, "-q", "-f", dumpPath]);
    const restoreMs = Date.now() - restoreStart;
    console.log(`  ..    restore took ${(restoreMs / 1000).toFixed(1)}s`);

    const recovered = createDb({ connectionString: recoveryUrl, max: 1 });

    try {
      await verifyRecovered(recovered.db, marker, expected, postBackupMarker);
    } finally {
      await recovered.pool.end();
    }

    console.log(
      `\n  RECOVERY TIME: backup ${(dumpMs / 1000).toFixed(1)}s + restore ` +
        `${(restoreMs / 1000).toFixed(1)}s = ${((dumpMs + restoreMs) / 1000).toFixed(1)}s total`,
    );
  } finally {
    // --- clean up -------------------------------------------------------
    try {
      pg(["psql", insideContainer(withDatabase(url, maintenanceDb(url))), "-c", `DROP DATABASE IF EXISTS ${RECOVERY_DB}`]);
      console.log(`\n  cleaned up: ${RECOVERY_DB} dropped`);
    } catch (error) {
      console.log(`\n  WARN  could not drop ${RECOVERY_DB}: ${String(error).slice(0, 120)}`);
    }
    try {
      pg(["rm", "-f", dumpPath]);
    } catch {
      /* best effort */
    }
    // The drill's own rows stay out of the live database.
    await db
      .execute(sql`DELETE FROM credit_wallets WHERE user_id IN (SELECT id FROM users WHERE normalized_email LIKE 'restore-drill-%' OR normalized_email LIKE 'after-%')`)
      .catch(() => {});
    await db
      .execute(sql`UPDATE users SET status = 'deleted', email = 'drill-' || id || '@deleted.invalid'
                    WHERE normalized_email LIKE 'restore-drill-%' OR normalized_email LIKE 'after-%'`)
      .catch(() => {});
    rmSync(work, { recursive: true, force: true });
    await pool.end();
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

/** Everything that has to be true of a restored database. */
async function verifyRecovered(
  rdb: Database,
  marker: string,
  expected: Record<string, string>,
  postBackupMarker: string,
): Promise<void> {
  console.log("\n=== 5. Verify what came back ===");

  const got = (
    await rdb.execute<Record<string, string>>(sql`
      SELECT (SELECT COUNT(*)::text FROM users)                                   AS users,
             (SELECT COUNT(*)::text FROM credit_ledger)                           AS ledger,
             (SELECT COUNT(*)::text FROM audit_events)                            AS audit,
             (SELECT balance::text FROM credit_wallets WHERE user_id = ${marker})  AS marker_balance,
             (SELECT COALESCE(SUM(amount),0)::text FROM credit_ledger WHERE user_id = ${marker}) AS marker_ledger
    `)
  ).rows[0]!;

  check("users recovered exactly", got.users === expected.users, `${got.users} vs ${expected.users}`);
  check(
    "ledger entries recovered exactly",
    got.ledger === expected.ledger,
    `${got.ledger} vs ${expected.ledger}`,
  );
  check(
    "audit events recovered exactly",
    got.audit === expected.audit,
    `${got.audit} vs ${expected.audit}`,
  );
  check(
    "the known balance recovered",
    got.marker_balance === expected.marker_balance,
    `${got.marker_balance} vs ${expected.marker_balance}`,
  );
  check(
    "the recovered wallet agrees with the recovered ledger",
    got.marker_balance === got.marker_ledger,
    `wallet=${got.marker_balance} ledger=${got.marker_ledger}`,
  );

  // The post-backup write must NOT be present. A restore that silently included
  // it would mean the recovery point is not where we think it is.
  const leaked = (
    await rdb.execute<{ n: string }>(
      sql`SELECT COUNT(*)::text AS n FROM credit_ledger WHERE reason = ${postBackupMarker}`,
    )
  ).rows[0]!;
  check("data written after the backup is absent", leaked.n === "0", `found=${leaked.n}`);

  const driftRow = (
    await rdb.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n FROM credit_wallets w
       WHERE w.balance <> COALESCE(
         (SELECT SUM(amount) FROM credit_ledger l WHERE l.user_id = w.user_id), 0)
    `)
  ).rows[0]!;
  check("no ledger drift anywhere in the recovered database", driftRow.n === "0", `drift=${driftRow.n}`);

  // --- schema, not just rows -------------------------------------------
  const objects = (
    await rdb.execute<Record<string, string>>(sql`
      SELECT (SELECT COUNT(*)::text FROM information_schema.tables
               WHERE table_schema='public' AND table_type='BASE TABLE')           AS tables,
             (SELECT COUNT(*)::text FROM information_schema.views
               WHERE table_schema='public')                                        AS views,
             (SELECT COUNT(*)::text FROM pg_indexes WHERE schemaname='public')     AS indexes,
             (SELECT COUNT(*)::text FROM information_schema.table_constraints
               WHERE constraint_schema='public' AND constraint_type='FOREIGN KEY') AS fks,
             (SELECT COUNT(*)::text FROM information_schema.table_constraints
               WHERE constraint_schema='public' AND constraint_type='CHECK')       AS checks,
             (SELECT COUNT(*)::text FROM pg_trigger t
               JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal)        AS triggers,
             (SELECT COUNT(*)::text FROM drizzle.__drizzle_migrations)             AS migrations
    `)
  ).rows[0]!;

  console.log(
    `  ..    recovered schema: ${objects.tables} tables, ${objects.views} views, ` +
      `${objects.indexes} indexes, ${objects.fks} FKs, ${objects.checks} checks, ` +
      `${objects.triggers} triggers, ${objects.migrations} migrations`,
  );

  check("tables recovered", Number(objects.tables) > 20);
  check("indexes recovered", Number(objects.indexes) > 20);
  check("foreign keys recovered", Number(objects.fks) > 10);
  check("check constraints recovered", Number(objects.checks) > 0);
  check("migration history recovered", Number(objects.migrations) >= 8);
  check("the generated normalized_email column survives", await hasGeneratedEmail(rdb));

  // --- the protections, proven by behaviour, not by presence ------------
  check("both append-only triggers are present", objects.triggers === "2", `n=${objects.triggers}`);

  for (const table of ["audit_events", "credit_ledger"]) {
    let refused = false;
    try {
      await rdb.execute(sql.raw(`UPDATE ${table} SET id = id`));
    } catch (error) {
      const chain = `${String((error as { cause?: unknown })?.cause ?? "")} ${String(error)}`;
      refused = /append-only/i.test(chain);
    }
    check(`${table} is still append-only after recovery`, refused);
  }
}

async function hasGeneratedEmail(rdb: Database): Promise<boolean> {
  const row = (
    await rdb.execute<{ is_generated: string }>(sql`
      SELECT is_generated FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'normalized_email'
    `)
  ).rows[0];
  return row?.is_generated === "ALWAYS";
}

void main();

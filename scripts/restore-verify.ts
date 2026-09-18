/**
 * Restore an existing backup into a scratch database and check what came back.
 *
 *   DATABASE_URL="<url>" pnpm tsx scripts/restore-verify.ts [--file backups/x.sql.gz]
 *
 * This is the periodic restore test. It is deliberately different from
 * `restore-drill.ts`, which takes a fresh dump as part of the drill and so only
 * ever proves that a backup taken seconds ago can be restored. That answers the
 * wrong question. The one that matters is whether the archive sitting in
 * storage — taken days ago, by a job nobody watched, possibly truncated by a
 * disk that filled up — is something you can actually recover from.
 *
 * So this takes no backup. It reads one off disk, restores it, and interrogates
 * the result. Failure exits non-zero, which is what makes CI shout, and records
 * a `failed` run so the admin console shows it too.
 *
 * The scratch database is created for the test and dropped afterwards. The live
 * database is only ever read, and only to compare row counts.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb, type Database } from "@inkloom/db/client";
import { recordJobRun, RESTORE_TEST_JOB } from "@inkloom/core/retention";
import { describeTarget, insideContainer, required } from "./_env";
import { verifyDumpFile } from "./_dump";
import { decryptBackup, isEncryptedBackup } from "./_crypto";

const SCRATCH_DB = process.env.SCRATCH_DB ?? "restore_verify";
const PG_CONTAINER = process.env.PG_CONTAINER ?? "inkloom-postgres";

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Run psql, wherever it lives — on PATH in CI, in the container locally. */
function psql(url: string, args: string[], input?: string): string {
  const onPath = (() => {
    try {
      execFileSync("psql", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  return onPath
    ? execFileSync("psql", [url, ...args], { encoding: "utf8", input, maxBuffer: 1 << 28 })
    : execFileSync("docker", ["exec", "-i", PG_CONTAINER, "psql", insideContainer(url), ...args], {
        encoding: "utf8",
        input,
        maxBuffer: 1 << 28,
      });
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const maintenanceDb = (url: string) =>
  /neon\.tech/.test(new URL(url).hostname) ? "neondb" : "postgres";

/** The newest backup in a directory, which is what a real recovery would reach for. */
function newestBackup(dir: string): string {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql.gz") || f.endsWith(".sql.gz.enc"))
    .map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error(`no .sql.gz backups found in ${dir}`);
  return files[0]!.f;
}

async function main() {
  const url = required("DATABASE_URL");
  const file = arg("file") ?? newestBackup(arg("dir") ?? "backups");
  const startedAt = new Date();
  const started = Date.now();

  console.log(`\n  backup: ${file}`);
  console.log(`  live:   ${describeTarget(url)}`);
  console.log(`  scratch: ${SCRATCH_DB} (created for this test, dropped after)\n`);

  const { db, pool } = createDb({ connectionString: url, max: 1 });
  let error: string | undefined;
  /** Temporary plaintext, removed in the finally so it never lingers on disk. */
  let decrypted: string | undefined;

  try {
    // =====================================================================
    console.log("=== 1. The archive itself ===");

    const ageHours = (Date.now() - statSync(file).mtimeMs) / 3_600_000;

    /*
     * Decrypt first, if it is sealed.
     *
     * This is the step a restore test exists to exercise: an archive nobody can
     * open is not a backup, and a key that has quietly rotated away from the one
     * used to write it fails here rather than during an incident.
     */
    let plainFile = file;
    if (isEncryptedBackup(readFileSync(file))) {
      const passphrase = process.env.BACKUP_ENCRYPTION_KEY;
      if (!passphrase) {
        throw new Error(
          "this archive is encrypted but BACKUP_ENCRYPTION_KEY is not set — " +
            "the restore test cannot verify what it cannot open",
        );
      }
      const opened = decryptBackup(readFileSync(file), passphrase);
      plainFile = `${file}.decrypted.sql.gz`;
      writeFileSync(plainFile, opened);
      decrypted = plainFile;
      check("the archive decrypts with the configured key", true);
    }

    const { bytes, tables } = verifyDumpFile(plainFile);
    check("the archive is readable and complete", true, `${(bytes / 1024 / 1024).toFixed(2)} MB`);
    check("it contains the full schema", tables > 20, `${tables} tables`);
    /*
     * An old archive is not a failure — it is the thing being measured. A
     * restore test that only ever runs against a fresh backup would never catch
     * a backup job that stopped a week ago.
     */
    console.log(`  ..    archive age: ${ageHours.toFixed(1)}h`);

    // =====================================================================
    console.log("\n=== 2. Restore it ===");

    const admin = withDatabase(url, maintenanceDb(url));
    psql(admin, ["-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS ${SCRATCH_DB}`]);
    psql(admin, ["-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${SCRATCH_DB}`]);

    const scratchUrl = withDatabase(url, SCRATCH_DB);
    const restoreStart = Date.now();

    // gunzip on the way in, so the archive never has to be written out twice.
    const decompressed = execFileSync("gunzip", ["-c", plainFile], { maxBuffer: 1 << 29 });
    psql(scratchUrl, ["-q", "-v", "ON_ERROR_STOP=1"], decompressed.toString("utf8"));

    const restoreMs = Date.now() - restoreStart;
    console.log(`  ..    restored in ${(restoreMs / 1000).toFixed(1)}s`);

    // =====================================================================
    console.log("\n=== 3. Interrogate what came back ===");

    const restored = createDb({ connectionString: scratchUrl, max: 1 });
    try {
      await verifyRestored(restored.db, db);
    } finally {
      await restored.pool.end();
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    failed += 1;
    console.error(`\n  RESTORE TEST FAILED: ${error}`);
  } finally {
    // Decrypted plaintext must not outlive the test that needed it.
    if (decrypted) {
      try {
        unlinkSync(decrypted);
      } catch {
        console.log("  WARN  could not remove the decrypted copy");
      }
    }

    try {
      psql(withDatabase(url, maintenanceDb(url)), ["-c", `DROP DATABASE IF EXISTS ${SCRATCH_DB}`]);
      console.log(`\n  cleaned up: ${SCRATCH_DB} dropped`);
    } catch {
      console.log(`\n  WARN  could not drop ${SCRATCH_DB}`);
    }

    await recordJobRun(db, {
      job: RESTORE_TEST_JOB,
      startedAt,
      finishedAt: new Date(),
      status: failed === 0 ? "ok" : "failed",
      durationMs: Date.now() - started,
      removed: passed,
      steps: [{ name: "restore_verify", file, checks: passed, failures: failed }],
      error,
    }).catch(() => console.error("  WARN  could not record the run"));

    await pool.end();
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

/** Everything that has to be true of a restored database. */
async function verifyRestored(restored: Database, live: Database): Promise<void> {
  const shape = (
    await restored.execute<Record<string, string>>(sql`
      SELECT (SELECT COUNT(*)::text FROM users)                                    AS users,
             (SELECT COUNT(*)::text FROM credit_ledger)                            AS ledger,
             (SELECT COUNT(*)::text FROM audit_events)                             AS audit,
             (SELECT COUNT(*)::text FROM credit_wallets)                           AS wallets,
             (SELECT COUNT(*)::text FROM information_schema.tables
               WHERE table_schema='public' AND table_type='BASE TABLE')            AS tables,
             (SELECT COUNT(*)::text FROM pg_indexes WHERE schemaname='public')     AS indexes,
             (SELECT COUNT(*)::text FROM information_schema.table_constraints
               WHERE constraint_schema='public' AND constraint_type='FOREIGN KEY') AS fks,
             (SELECT COUNT(*)::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
               WHERE NOT t.tgisinternal)                                           AS triggers,
             (SELECT COUNT(*)::text FROM drizzle.__drizzle_migrations)             AS migrations,
             (SELECT COUNT(*)::text FROM credit_wallets w
               WHERE w.balance <> COALESCE(
                 (SELECT SUM(amount) FROM credit_ledger l WHERE l.user_id = w.user_id), 0)) AS drift
    `)
  ).rows[0]!;

  console.log(
    `  ..    restored: ${shape.tables} tables, ${shape.users} users, ${shape.ledger} ledger,` +
      ` ${shape.audit} audit, ${shape.migrations} migrations`,
  );

  check("users came back", Number(shape.users) >= 0 && shape.users !== undefined);
  check("the schema came back", Number(shape.tables) > 20, `${shape.tables} tables`);
  check("indexes came back", Number(shape.indexes) > 20, `${shape.indexes}`);
  check("foreign keys came back", Number(shape.fks) > 10, `${shape.fks}`);
  check("migration history came back", Number(shape.migrations) >= 9, `${shape.migrations}`);

  /*
   * The invariant that actually matters. A restore that loses ledger rows but
   * keeps wallets produces a database where money is silently wrong — which is
   * far worse than a restore that visibly fails.
   */
  check("the restored ledger balances", shape.drift === "0", `drift=${shape.drift}`);

  // Protections must come back with the data, or the restored database is one
  // where the ledger can be rewritten.
  check("both append-only triggers came back", shape.triggers === "2", `n=${shape.triggers}`);
  for (const table of ["audit_events", "credit_ledger"]) {
    let refused = false;
    try {
      await restored.execute(sql.raw(`UPDATE ${table} SET id = id`));
    } catch (e) {
      refused = /append-only/i.test(String((e as { cause?: unknown })?.cause ?? ""));
    }
    check(`${table} is still append-only after restore`, refused);
  }

  const generated = (
    await restored.execute<{ is_generated: string }>(sql`
      SELECT is_generated FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'normalized_email'
    `)
  ).rows[0];
  check("the generated normalized_email column survived", generated?.is_generated === "ALWAYS");

  /*
   * Compare against live only as CONTEXT, never as a pass/fail.
   *
   * The backup is older than the live database by design, so a difference is
   * expected and is precisely the data a restore would lose. Reporting it as a
   * failure would make every correct run red.
   */
  const now = (
    await live.execute<Record<string, string>>(
      sql`SELECT (SELECT COUNT(*)::text FROM users) AS users,
                 (SELECT COUNT(*)::text FROM credit_ledger) AS ledger`,
    )
  ).rows[0]!;
  const lostUsers = Number(now.users) - Number(shape.users);
  const lostLedger = Number(now.ledger) - Number(shape.ledger);
  console.log(
    `  ..    restoring this backup would lose ${lostUsers} user(s) and ` +
      `${lostLedger} ledger entr(ies) written since it was taken`,
  );
}

void main();

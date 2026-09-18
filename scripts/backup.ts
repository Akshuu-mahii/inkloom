/**
 * Take a database backup, verify it is readable, and record that it happened.
 *
 *   DATABASE_URL="<url>" pnpm tsx scripts/backup.ts --out backups/
 *
 * Designed to run unattended from CI. Three properties matter more than speed:
 *
 *  1. It VERIFIES what it wrote. A backup nobody has read back is a file, not a
 *     backup. This one re-reads the dump, checks the objects it must contain,
 *     and refuses to report success on a truncated or empty file.
 *  2. It RECORDS the run in `job_runs`, the same table the retention sweep uses.
 *     That is what makes a missing backup visible: the admin overview reads the
 *     newest row's age, so a job that silently stops running turns the console
 *     amber without anyone having to remember to check.
 *  3. It FAILS LOUDLY. A non-zero exit is what makes CI send the email. A backup
 *     script that swallows its own errors is worse than none, because it
 *     produces the paperwork of safety without the safety.
 *
 * The dump is plain SQL, gzipped: portable, greppable, and restorable with
 * nothing but `psql`. Custom format would be smaller and would need `pg_restore`
 * at exactly the right version during an incident, which is not a trade worth
 * making at 3am.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb } from "@inkloom/db/client";
import { BACKUP_JOB, recordJobRun } from "@inkloom/core/retention";
import { describeTarget, insideContainer, required } from "./_env";
import { verifyDumpFile } from "./_dump";
import { encryptBackup } from "./_crypto";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * `pg_dump`, wherever it lives.
 *
 * On CI it is on PATH. Locally it usually is not, but the Postgres container
 * has it — and its version matches the server, which matters because pg_dump
 * refuses to dump a server newer than itself.
 */
function pgDump(args: string[]): { stdout: Buffer; usedDocker: boolean } {
  const direct = spawnSync("pg_dump", ["--version"], { encoding: "utf8" });
  if (direct.status === 0) {
    return {
      stdout: execFileSync("pg_dump", args, { maxBuffer: 1024 * 1024 * 1024 }),
      usedDocker: false,
    };
  }

  const container = process.env.PG_CONTAINER ?? "inkloom-postgres";
  // The URL is always the first argument; translate it for the container.
  const inside = args.map((a, i) => (i === 0 ? insideContainer(a) : a));
  return {
    stdout: execFileSync("docker", ["exec", "-i", container, "pg_dump", ...inside], {
      maxBuffer: 1024 * 1024 * 1024,
    }),
    usedDocker: true,
  };
}

async function main() {
  // Verify-only: check an existing archive without touching a database.
  const verifyOnly = arg("verify");
  if (verifyOnly) {
    const { bytes, tables } = verifyDumpFile(verifyOnly);
    console.log(
      `\n  ${verifyOnly}\n  OK — ${(bytes / 1024 / 1024).toFixed(2)} MB, ${tables} tables\n`,
    );
    process.exit(0);
  }

  const url = required("DATABASE_URL");
  const outDir = arg("out") ?? "backups";
  const label = arg("label") ?? "manual";
  const startedAt = new Date();
  const started = Date.now();

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const file = join(outDir, `inkloom-${label}-${stamp}.sql.gz`);

  console.log(`\n  source: ${describeTarget(url)}`);
  console.log(`  target: ${file}`);

  /*
   * A preflight that names the environment, without naming any secret.
   *
   * Written after a failed CI run that could not be diagnosed from here at all:
   * the summary said "exit code 1", and every candidate cause — a missing key,
   * a key too short, the wrong pg_dump, an unreachable host — produces the same
   * line. None of the values below are sensitive: a length is not a key, and a
   * hostname is not a connection string. Together they identify which of those
   * it was on the first read, instead of after a round of guessing.
   */
  const keyLength = (process.env.BACKUP_ENCRYPTION_KEY ?? "").length;
  let pgDumpVersion = "NOT FOUND";
  try {
    const direct = spawnSync("pg_dump", ["--version"], { encoding: "utf8" });
    pgDumpVersion =
      direct.status === 0
        ? `${direct.stdout.trim()} (PATH)`
        : `${execFileSync("docker", ["exec", "-i", process.env.PG_CONTAINER ?? "inkloom-postgres", "pg_dump", "--version"], { encoding: "utf8" }).trim()} (container)`;
  } catch {
    /* reported as NOT FOUND below */
  }

  console.log(`  preflight:`);
  console.log(`    node            ${process.version}`);
  console.log(`    pg_dump         ${pgDumpVersion}`);
  console.log(`    database host   ${new URL(url).hostname}`);
  console.log(
    `    encryption key  ${keyLength === 0 ? "NOT SET" : `set, ${keyLength} characters`}` +
      `${keyLength > 0 && keyLength < 16 ? "  <-- TOO SHORT, minimum is 16" : ""}`,
  );
  console.log(`    CI              ${process.env.CI ? "yes" : "no"}\n`);

  const { db, pool } = createDb({ connectionString: url, max: 1 });
  let status: "ok" | "failed" = "ok";
  let finalFile = file;
  let error: string | undefined;
  let rowsCovered = 0;

  try {
    // What the live database holds, so the dump can be checked against it.
    const live = (
      await db.execute<Record<string, string>>(sql`
        SELECT (SELECT COUNT(*)::text FROM users)         AS users,
               (SELECT COUNT(*)::text FROM credit_ledger) AS ledger,
               (SELECT COUNT(*)::text FROM audit_events)  AS audit,
               (SELECT COUNT(*)::text FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables
      `)
    ).rows[0]!;
    rowsCovered = Number(live.users) + Number(live.ledger) + Number(live.audit);
    console.log(
      `  live: ${live.tables} tables, ${live.users} users, ${live.ledger} ledger, ${live.audit} audit`,
    );

    // --- take it --------------------------------------------------------
    const { stdout, usedDocker } = pgDump([
      url,
      "--no-owner",
      "--no-privileges",
      "--format=plain",
      "--compress=6",
    ]);
    writeFileSync(file, stdout);
    console.log(`  pg_dump via ${usedDocker ? "container" : "PATH"}`);

    // --- verify it ------------------------------------------------------
    const { bytes, userRows } = verifyDumpFile(file);

    // Row counts, read back out of the dump's own COPY block.
    if (userRows !== null && userRows !== Number(live.users)) {
      console.log(
        `  WARN  users in dump (${userRows}) differs from live (${live.users}) —` +
          " expected if writes landed during the dump",
      );
    }

    console.log(
      `  verified: ${(bytes / 1024 / 1024).toFixed(2)} MB, all required objects present,` +
        ` not truncated`,
    );

    /*
     * Encrypt LAST, after verification has read the real dump.
     *
     * Order matters: verifying the plaintext proves the backup is good, and
     * encrypting afterwards means what leaves this machine is ciphertext. Doing
     * it the other way round would mean either verifying nothing, or holding
     * the key in order to check — and the whole point is that the storage
     * provider never sees plaintext.
     *
     * Unencrypted is allowed for a local drill, and says so loudly. It is not
     * allowed to be the silent default in CI, where the file travels.
     */
    const passphrase = process.env.BACKUP_ENCRYPTION_KEY;
    if (passphrase) {
      const sealed = encryptBackup(readFileSync(file), passphrase);
      writeFileSync(`${file}.enc`, sealed);
      unlinkSync(file);
      finalFile = `${file}.enc`;
      console.log(
        `  encrypted: AES-256-GCM, ${(sealed.length / 1024 / 1024).toFixed(2)} MB ->` +
          ` ${finalFile}`,
      );
    } else if (process.env.CI) {
      throw new Error(
        "BACKUP_ENCRYPTION_KEY is not set. A dump holds every address, profile and " +
          "ledger entry; it must not leave this runner in plaintext.",
      );
    } else {
      console.log("  NOT ENCRYPTED — set BACKUP_ENCRYPTION_KEY before storing this anywhere");
    }
  } catch (e) {
    status = "failed";
    error = e instanceof Error ? e.message : String(e);
    console.error(`\n  BACKUP FAILED: ${error}`);

    /*
     * Put the reason on the run summary, not only in the step log.
     *
     * Without this a failed run shows "Process completed with exit code 1" on
     * the summary page and the actual cause is buried several clicks deep in a
     * collapsed step. The first real failure of this workflow cost exactly that
     * detour, which is the wrong thing to be doing during a backup outage.
     */
    if (process.env.CI) {
      console.log(`::error title=Backup failed::${error.replace(/\n/g, " ")}`);
    }
  } finally {
    /*
     * Record the run either way, and never let recording fail the backup.
     *
     * A `failed` row is what turns a broken backup into something the admin
     * overview shows, rather than a CI email nobody opened. If the database is
     * what broke, this insert cannot work either — staleness is the backstop
     * that depends on nothing working.
     */
    await recordJobRun(db, {
      job: BACKUP_JOB,
      startedAt,
      finishedAt: new Date(),
      status,
      durationMs: Date.now() - started,
      removed: rowsCovered,
      steps: [{ name: "pg_dump", file: finalFile, label, ok: status === "ok" }],
      error,
    }).catch((e: unknown) => console.error(`  WARN  could not record the run: ${String(e)}`));

    await pool.end();
  }

  console.log(
    `\n  ${status === "ok" ? "BACKUP OK" : "BACKUP FAILED"} in ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
  );
  // Non-zero is what makes CI shout.
  process.exit(status === "ok" ? 0 : 1);
}

void main();

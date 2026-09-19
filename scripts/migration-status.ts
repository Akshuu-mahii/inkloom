/**
 * Reports what a migration will do, and afterwards proves it did it.
 *
 *   pnpm db:status              what is pending (read-only)
 *   pnpm db:status --sql        ...and print the SQL of each pending migration
 *   pnpm db:status --verify     assert nothing is pending, then check the schema
 *   pnpm db:status --allow-destructive   proceed past the compatibility gate
 *
 * The two modes are deliberately the same question asked twice. Before a
 * migration it answers "what is about to change"; after it, "did every change
 * land, and does the database now match the code". Anything a deploy could do
 * between those two answers shows up as a difference.
 *
 * `--verify` checks three things the migration runner itself cannot:
 *
 *   1. Every table and column in the Drizzle schema exists in the database.
 *      Drizzle only records THAT a migration ran, not that its effect survived,
 *      so a hand-edited database passes the journal check and still breaks at
 *      the first query.
 *   2. The views and append-only triggers exist. These are written by hand in
 *      the migration SQL and have no representation in the ORM schema, so
 *      nothing else in the codebase would notice them missing — and the
 *      append-only triggers are what make the credit ledger and the audit log
 *      trustworthy rather than merely conventional.
 *   3. Nothing is pending.
 *
 * Read-only throughout: it issues no DDL and no writes in either mode.
 */
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { readFileSync } from "node:fs";
import pg from "pg";
import * as schema from "@inkloom/db/schema";
import { describeTarget, required } from "./_env";
import { incompatibilities, journal } from "./_migrations";

/**
 * Objects created by raw SQL in the migrations and absent from the ORM schema.
 *
 * Listed by hand because there is nowhere else to derive them from — that is
 * precisely why they need checking. Keep this in step with the migrations.
 */
const EXPECTED_VIEWS = ["password_reset_tokens", "credit_wallet_drift"];
const EXPECTED_APPEND_ONLY = ["credit_ledger", "audit_events"];

interface AppliedRow {
  hash: string;
  created_at: string;
}

async function appliedHashes(pool: pg.Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `select exists (
       select 1 from information_schema.tables
       where table_schema = 'drizzle' and table_name = '__drizzle_migrations'
     ) as exists`,
  );
  // A database that has never been migrated has no ledger table at all. That is
  // a valid starting state, not an error: everything is pending.
  if (!rows[0].exists) return new Set();

  const applied = await pool.query<AppliedRow>(
    `select hash, created_at from drizzle.__drizzle_migrations order by created_at`,
  );
  return new Set(applied.rows.map((row) => row.hash));
}

async function missingSchemaObjects(pool: pg.Pool): Promise<string[]> {
  const problems: string[] = [];

  const { rows: columns } = await pool.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
     where table_schema = 'public'`,
  );
  const present = new Map<string, Set<string>>();
  for (const row of columns) {
    if (!present.has(row.table_name)) present.set(row.table_name, new Set());
    present.get(row.table_name)!.add(row.column_name);
  }

  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value as PgTable);
    const columnsPresent = present.get(config.name);
    if (!columnsPresent) {
      problems.push(`table "${config.name}" is missing`);
      continue;
    }
    for (const column of config.columns) {
      if (!columnsPresent.has(column.name)) {
        problems.push(`column "${config.name}.${column.name}" is missing`);
      }
    }
  }

  const { rows: views } = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.views where table_schema = 'public'`,
  );
  const viewNames = new Set(views.map((row) => row.table_name));
  for (const view of EXPECTED_VIEWS) {
    if (!viewNames.has(view)) problems.push(`view "${view}" is missing`);
  }

  // `tgenabled = 'D'` is a trigger that exists but is switched off — which
  // looks identical to a healthy one in every listing that checks existence.
  const { rows: triggers } = await pool.query<{ table: string; enabled: string }>(
    `select c.relname as table, t.tgenabled as enabled
     from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and not t.tgisinternal and t.tgname like '%append_only'`,
  );
  for (const table of EXPECTED_APPEND_ONLY) {
    const trigger = triggers.find((row) => row.table === table);
    if (!trigger) {
      problems.push(`append-only trigger on "${table}" is missing`);
    } else if (trigger.enabled === "D") {
      problems.push(`append-only trigger on "${table}" is DISABLED`);
    }
  }

  return problems;
}

async function main() {
  const url = required("DATABASE_URL");
  const verify = process.argv.includes("--verify");
  const withSql = process.argv.includes("--sql");
  const allowDestructive = process.argv.includes("--allow-destructive");

  console.log(`Database: ${describeTarget(url)}\n`);

  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });
  pool.on("error", () => {});

  try {
    const applied = await appliedHashes(pool);
    const entries = journal();
    const pending = entries.filter((entry) => !applied.has(entry.hash));

    console.log(`Migrations in repo : ${entries.length}`);
    console.log(`Already applied    : ${entries.length - pending.length}`);
    console.log(`Pending            : ${pending.length}`);

    if (pending.length > 0) {
      console.log("");
      for (const entry of pending) {
        const sql = readFileSync(entry.file, "utf8");
        const problems = incompatibilities(sql);
        console.log(`  - ${entry.tag}${problems.length > 0 ? "   [NOT BACKWARD-COMPATIBLE]" : ""}`);
        for (const problem of problems) console.log(`      ${problem}`);
      }
      if (withSql) {
        for (const entry of pending) {
          console.log(`\n--- ${entry.tag}.sql ---`);
          console.log(readFileSync(entry.file, "utf8").trimEnd());
        }
      }
    }

    if (!verify) {
      // The compatibility gate belongs to the "about to migrate" reading, not
      // the "did it work" one, and it only has meaning when there IS a running
      // version to stay compatible with. A database with no migration ledger
      // has never served anything, so every statement in the initial schema is
      // trivially safe and blocking it would make a first deploy impossible.
      if (applied.size === 0) {
        if (pending.length > 0) {
          console.log("\nFirst migration of an empty database: nothing is running against it,");
          console.log("so the backward-compatibility rule does not apply.");
        }
        return;
      }

      const unsafe = pending.filter(
        (entry) => incompatibilities(readFileSync(entry.file, "utf8")).length > 0,
      );
      if (unsafe.length > 0 && !allowDestructive) {
        console.error("\n  REFUSED: pending migrations are not backward-compatible with the");
        console.error("  version currently deployed, and migrations run BEFORE the new code.");
        console.error("  Split them expand -> migrate -> contract (docs/DEPLOYMENT.md), or");
        console.error("  re-run with --allow-destructive once a human has read the SQL above.\n");
        process.exit(1);
      }
      if (unsafe.length > 0) {
        console.log("\n  Proceeding with --allow-destructive. The rollback path is now code-only.");
      }
      return;
    }

    const problems: string[] = [];
    if (pending.length > 0) {
      problems.push(`${pending.length} migration(s) still pending after the run`);
    }
    problems.push(...(await missingSchemaObjects(pool)));

    if (problems.length > 0) {
      console.error("\nSchema verification FAILED:");
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exit(1);
    }

    // Row counts, reported and never asserted. A fresh production database is
    // legitimately empty; printing the counts lets an operator confirm that
    // nothing seeded rows behind their back without the check itself becoming
    // a reason to put fake data in.
    const { rows: counts } = await pool.query<{ table: string; rows: string }>(
      `select 'users' as table, count(*)::text as rows from users
       union all select 'access_code_campaigns', count(*)::text from access_code_campaigns
       union all select 'credit_ledger', count(*)::text from credit_ledger
       union all select 'roles', count(*)::text from roles`,
    );
    console.log("\nSchema verified. Row counts:");
    for (const row of counts) console.log(`  ${row.table.padEnd(24)} ${row.rows}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Migration status failed:", error);
  process.exit(1);
});

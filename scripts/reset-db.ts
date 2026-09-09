/**
 * Destructive: drops and recreates the `public` schema, then re-applies every
 * migration.
 *
 * Guard rails, because this deletes data:
 *   1. Refuses outright if DATABASE_URL points at a non-local host, unless
 *      INKLOOM_ALLOW_REMOTE_RESET=i-understand is set.
 *   2. Refuses if INKLOOM_ENV is "production".
 *   3. Requires the operator to type the database name back, exactly.
 *
 * `--force` skips only the typed confirmation (for CI), never the host checks.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { execFileSync } from "node:child_process";
import { createDb } from "@inkloom/db/client";
import { describeTarget, looksRemote, repoRoot, required } from "./_env";

async function main() {
  const url = required("DATABASE_URL");
  const target = describeTarget(url);
  const dbName = new URL(url).pathname.slice(1);

  if (process.env.INKLOOM_ENV === "production") {
    console.error("Refusing to reset: INKLOOM_ENV is 'production'.");
    process.exit(1);
  }

  if (looksRemote(url) && process.env.INKLOOM_ALLOW_REMOTE_RESET !== "i-understand") {
    console.error(`Refusing to reset a non-local database (${target}).`);
    console.error("If this is genuinely a disposable staging branch, set");
    console.error("INKLOOM_ALLOW_REMOTE_RESET=i-understand and run again.");
    process.exit(1);
  }

  const forced = process.argv.includes("--force");
  if (!forced) {
    console.log(`\n  This DROPS EVERY TABLE in: ${target}`);
    console.log("  All users, credits, ledger entries and audit history will be lost.\n");
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(`  Type the database name (${dbName}) to confirm: `);
    rl.close();
    if (answer.trim() !== dbName) {
      console.log("\n  Cancelled — nothing was changed.\n");
      process.exit(1);
    }
  }

  const { db, pool } = createDb({ connectionString: url, max: 1 });
  try {
    // CASCADE also removes the append-only triggers and views from 0001.
    await db.execute("DROP SCHEMA IF EXISTS public CASCADE");
    await db.execute("CREATE SCHEMA public");
    await db.execute("DROP SCHEMA IF EXISTS drizzle CASCADE");
    console.log(`  Schema dropped on ${target}.`);
  } finally {
    await pool.end();
  }

  execFileSync("pnpm", ["--filter", "@inkloom/db", "migrate"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  console.log(`\n  Reset complete. Run 'pnpm db:seed' to load development data.\n`);
}

main().catch((error) => {
  console.error("Reset failed:", error);
  process.exit(1);
});

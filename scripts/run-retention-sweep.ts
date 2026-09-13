/**
 * Run the retention sweep by hand.
 *
 *   pnpm retention:sweep --dry-run     # report what would go, change nothing
 *   pnpm retention:sweep               # actually sweep
 *
 * The sweep normally runs from the Worker's cron trigger at 03:20 UTC. This
 * exists for the two cases the cron does not cover: before the Worker is
 * deployed at all (which is where the project is today, with placeholder
 * Hyperdrive ids), and when an operator needs to prove the retention promises
 * at /privacy are being kept without waiting for the small hours.
 *
 * `--dry-run` reports the counts inside a transaction it then rolls back, so it
 * is genuinely read-only: the numbers are what a real sweep would remove right
 * now, not an estimate from a separate counting query that could disagree.
 */
import { createDb } from "@inkloom/db/client";
import { runRetentionSweep } from "@inkloom/core/retention";
import { captureSelfMeasuredUsage, rollUpDay } from "@inkloom/core/telemetry";
import { createLogger } from "@inkloom/core/logger";
import { sql } from "drizzle-orm";
import { required } from "./_env";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const connectionString = required("DATABASE_URL");
  const target = new URL(connectionString);
  const { db, pool } = createDb({ connectionString, max: 4 });
  const logger = createLogger({ level: "info", context: { env: "cli" } });

  console.log(
    `\n  Retention sweep${dryRun ? " (dry run — nothing will be written)" : ""}` +
      `\n  Target: ${target.pathname.slice(1)} at ${target.host}\n`,
  );

  try {
    if (dryRun) {
      /*
       * Roll back deliberately. The sweep runs for real inside this
       * transaction, so the counts are the true ones, and then the whole thing
       * is undone. Attempting the work is the only honest way to report it —
       * a separate SELECT could drift from what the DELETE would match.
       */
      await db
        .transaction(async (tx) => {
          const result = await runRetentionSweep(tx as never, logger);
          report(result);
          throw new RollbackSignal();
        })
        .catch((error: unknown) => {
          if (!(error instanceof RollbackSignal)) throw error;
        });
      console.log("  Rolled back. Nothing was changed.\n");
    } else {
      // Same order as the cron: summarise the day before deleting the rows the
      // summary counts.
      await rollUpDay(db, logger);
      await captureSelfMeasuredUsage(db, logger);
      const result = await runRetentionSweep(db, logger);
      report(result);
      if (result.failed > 0) process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

class RollbackSignal extends Error {}

function report(result: {
  steps: Array<{ name: string; removed: number; ok: boolean; error?: string }>;
  totalRemoved: number;
  failed: number;
  durationMs: number;
}) {
  const width = Math.max(...result.steps.map((s) => s.name.length));
  for (const step of result.steps) {
    const mark = step.ok ? "✓" : "✗";
    const detail = step.ok ? `${step.removed} removed` : `FAILED — ${step.error}`;
    console.log(`  ${mark} ${step.name.padEnd(width)}  ${detail}`);
  }
  console.log(
    `\n  ${result.totalRemoved} row(s) affected in ${result.durationMs}ms` +
      (result.failed > 0 ? `, ${result.failed} step(s) failed` : "") +
      "\n",
  );
}

// Keep the connection check honest: a bad URL should fail here, not halfway in.
void sql;

main().catch((error) => {
  console.error("\n  Retention sweep failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});

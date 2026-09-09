/**
 * Credit reconciliation.
 *
 *   pnpm credits:reconcile            report only
 *   pnpm credits:reconcile --repair   correct drifted wallet caches
 *
 * The ledger is the source of truth; a wallet balance is a cache. This command
 * re-sums the ledger per user and reports every wallet that disagrees.
 *
 * `--repair` only ever moves the CACHE toward the ledger. It never writes a
 * ledger entry and never adjusts the ledger to match a wallet — doing so would
 * mean rewriting accounting history to hide a bug.
 *
 * Exit code 1 when drift is found and not repaired, so CI or a cron can alert.
 */
import { sql } from "drizzle-orm";
import { createDb } from "@inkloom/db/client";
import { CreditService } from "@inkloom/core/credits";
import { createLogger } from "@inkloom/core/logger";
import { describeTarget, required } from "./_env";

async function main() {
  const url = required("DATABASE_URL");
  const repair = process.argv.includes("--repair");
  const json = process.argv.includes("--json");

  const { db, pool } = createDb({ connectionString: url, max: 2 });
  const logger = createLogger({ level: json ? "error" : "info" });
  const credits = new CreditService(db, logger);

  try {
    const result = await credits.reconcile({ repair });

    // A second, independent check: every entry's balance_after must equal the
    // running total of the entries before it. Catches a corrupted chain even
    // when the final total happens to agree.
    const chain = await db.execute<{ user_id: string; entries: string }>(sql`
      SELECT user_id, COUNT(*)::text AS entries
      FROM (
        SELECT user_id,
               balance_after,
               SUM(amount) OVER (PARTITION BY user_id ORDER BY created_at, id) AS running
        FROM credit_ledger
      ) t
      WHERE balance_after <> running
      GROUP BY user_id
    `);

    if (json) {
      console.log(JSON.stringify({ ...result, brokenChains: chain.rows }, null, 2));
    } else {
      console.log(`\n  Reconciliation on ${describeTarget(url)}\n`);
      console.log(`    wallets checked   ${result.checked}`);
      console.log(`    drifted           ${result.drifted.length}`);
      console.log(`    repaired          ${result.repaired}`);
      console.log(`    broken chains     ${chain.rows.length}`);

      for (const row of result.drifted) {
        console.log(
          `\n    ${row.userId}  cached=${row.cached}  ledger=${row.actual}  delta=${row.cached - row.actual}`,
        );
      }
      for (const row of chain.rows) {
        console.log(`\n    chain mismatch for ${row.user_id} (${row.entries} entries)`);
      }
      console.log(
        result.drifted.length === 0 && chain.rows.length === 0
          ? "\n  Every wallet reconciles with the ledger.\n"
          : repair
            ? "\n  Drift repaired. Investigate how it happened.\n"
            : "\n  Drift found. Re-run with --repair once you understand the cause.\n",
      );
    }

    const unresolved = (repair ? 0 : result.drifted.length) + chain.rows.length;
    process.exit(unresolved > 0 ? 1 : 0);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Reconciliation failed:", error);
  process.exit(1);
});

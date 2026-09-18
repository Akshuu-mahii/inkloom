/**
 * Damage a THROWAWAY database, for the recovery drill.
 *
 * Refuses to touch anything but a scratch database whose name says so. The
 * drill does not need the live database harmed to be meaningful: what is being
 * proved is that damage is DETECTED and that a restore undoes it, and both are
 * fully demonstrable on a disposable copy.
 *
 * The shape of the damage is the one that actually happens — an UPDATE that
 * forgot its WHERE clause. It is silent, instant, and the application keeps
 * serving happily afterwards; it simply tells everyone their credits are gone.
 */
import { sql } from "drizzle-orm";
import { createDb } from "@inkloom/db/client";

async function main() {
  const url = process.env.DATABASE_URL!;
  const name = new URL(url).pathname.slice(1);

  if (!/^(recovery|scratch|drill)/.test(name)) {
    console.error(
      `\n  Refusing: "${name}" is not a scratch database.` +
        `\n  This destroys data and may only run against recovery_* / scratch_* / drill_*.\n`,
    );
    process.exit(1);
  }

  const { db, pool } = createDb({ connectionString: url, max: 1 });

  const wallets = await db.execute(sql`UPDATE credit_wallets SET balance = 0`);
  const sessions = await db.execute(sql`DELETE FROM sessions`);

  console.log(`  wallets zeroed:   ${wallets.rowCount}`);
  console.log(`  sessions deleted: ${sessions.rowCount}`);
  await pool.end();
}

void main();

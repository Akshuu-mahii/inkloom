/**
 * Erase an account on request.
 *
 *   pnpm account:erase --email someone@example.com
 *   pnpm account:erase --email someone@example.com --apply
 *
 * /privacy says erasure happens when someone writes and asks for it. This is
 * how that promise is kept. There is no button in the product any more — that
 * was removed deliberately, because an irreversible action sitting one click
 * from "export my data" is a support burden long before it is a feature — so
 * the capability lives here, where it is deliberate, audited, and performed by
 * a person who has read the request.
 *
 * Dry run by default. Without `--apply` it finds the account, prints what will
 * be destroyed and stops, because the operator is acting on someone else's
 * behalf and "wrong account" is the failure that matters.
 *
 * The account becomes a tombstone rather than a deleted row: the append-only
 * audit trail and credit ledger reference this user id and cannot be rewritten,
 * so the id survives while everything identifying about it is destroyed. See
 * `@inkloom/core/privacy`.
 */
import { eq, sql } from "drizzle-orm";
import { createDb } from "@inkloom/db/client";
import { user as userTable } from "@inkloom/db";
import { AuditService } from "@inkloom/core/audit";
import { createLogger } from "@inkloom/core/logger";
import { anonymiseAccount } from "@inkloom/core/privacy";
import { describeTarget, required } from "./_env";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  const apply = process.argv.includes("--apply");
  const reason = arg("reason") ?? "Erasure requested by the account holder";

  if (!email) {
    console.error("\n  Usage: pnpm account:erase --email someone@example.com [--apply]\n");
    process.exit(1);
  }

  const url = required("DATABASE_URL");
  const { db, pool } = createDb({ connectionString: url, max: 1 });
  const logger = createLogger({ level: "info", context: { env: "cli" } });
  const audit = new AuditService(db, logger);

  try {
    console.log(`\n  Target: ${describeTarget(url)}`);

    const account = await db.query.user.findFirst({
      where: eq(userTable.normalizedEmail, email),
    });

    if (!account) {
      console.error(`\n  No account found for ${email}.\n`);
      process.exit(1);
    }
    if (account.anonymizedAt) {
      console.error(`\n  Already erased on ${account.anonymizedAt.toISOString()}.\n`);
      process.exit(1);
    }

    /*
     * The last-owner refusal is enforced by `anonymiseAccount` itself, inside
     * its transaction. Reported here too, so a dry run says so before the
     * operator schedules the real one rather than after.
     */
    if (account.role === "super_admin") {
      const others = await db.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text AS n FROM users
         WHERE role = 'super_admin' AND status = 'active' AND id <> ${account.id}
      `);
      if (Number(others.rows[0]?.n ?? 0) === 0) {
        console.error(
          "\n  This is the only owner. Promote another one first; erasure will refuse.\n",
        );
        process.exit(1);
      }
    }

    console.log(`  Account: ${account.id}  ${account.email}  (${account.role}, ${account.status})`);
    console.log(`  Created: ${account.createdAt?.toISOString() ?? "unknown"}`);

    if (!apply) {
      console.log("\n  Dry run. Nothing was changed. Re-run with --apply to erase.\n");
      return;
    }

    const result = await anonymiseAccount(db, audit, logger, {
      userId: account.id,
      actorType: "admin",
      actorId: null,
      reason,
    });

    console.log(`\n  Erased at ${result.anonymizedAt.toISOString()}.`);
    for (const [table, count] of Object.entries(result.removed)) {
      if (count > 0) console.log(`    ${table.padEnd(26)} ${count}`);
    }
    console.log("\n  The credit ledger keeps its entries under an opaque id, by design.\n");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Erasure failed:", error);
  process.exit(1);
});

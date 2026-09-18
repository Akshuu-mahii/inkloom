/**
 * Create load-test accounts directly, bypassing HTTP.
 *
 * The deployed signup endpoint requires a Turnstile token, which a bot cannot
 * produce and which must not be disabled on an internet-facing host. But
 * Turnstile guards the HTTP endpoint, not the domain logic — so a seeding script
 * that calls Better Auth's own `signUpEmail` creates exactly the accounts the
 * product would, with the same salted scrypt password hash, without weakening
 * anything.
 *
 * Password hashing is Better Auth's default scrypt and does NOT involve
 * BETTER_AUTH_SECRET, so an account created here logs in fine through the
 * deployed Worker even though this process does not hold the real secret. Only
 * session token signing uses that secret, and sessions are minted by the Worker.
 *
 * Every address is `@example.test`, reserved by RFC 2606 and unregistrable, so
 * the Resend transport refuses to deliver to it in any environment.
 *
 *   DATABASE_URL=... tsx scripts/seed-load-users.ts <count> [--delete]
 */
import { sql } from "drizzle-orm";
import { createDb } from "@inkloom/db/client";
import { createAuth } from "@inkloom/core/auth";
import { loadConfig } from "@inkloom/core/config";
import { createLogger } from "@inkloom/core/logger";
import { ConsoleTransport } from "@inkloom/email";
import { required } from "./_env";

const COUNT = Number(process.argv[2] ?? 100);
const DELETE_ONLY = process.argv.includes("--delete");
export const LOAD_PASSWORD = "load-test-passphrase-9!";
const PREFIX = process.env.LOAD_PREFIX ?? "loadbot";

async function main() {
  const url = required("DATABASE_URL");
  const { db, pool } = createDb({ connectionString: url, max: 10 });

  try {
    if (DELETE_ONLY) {
      const gone = await db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`${PREFIX}-%@example.test`} RETURNING id`,
      );
      console.log(`\n  removed ${gone.rowCount ?? 0} load-test accounts\n`);
      return;
    }

    /*
     * A configuration good enough to construct the auth instance and nothing
     * more. The secret here is NOT the deployed one and does not need to be:
     * it signs nothing that leaves this process, and the password hash it
     * produces is independent of it.
     */
    const config = loadConfig({
      INKLOOM_ENV: "development",
      APP_URL: "http://localhost:5173",
      DATABASE_URL: url,
      BETTER_AUTH_SECRET: "seeding-only-not-the-deployed-secret-000000",
      ACCESS_CODE_PEPPER: "seeding-only-pepper-0000000000000000",
      IP_HASH_PEPPER: "seeding-only-ip-pepper-00000000000000",
      EMAIL_TRANSPORT: "console",
      TURNSTILE_ENABLED: "false",
      TURNSTILE_SITE_KEY: "",
      TURNSTILE_SECRET_KEY: "",
    });

    const logger = createLogger({ level: "error", context: {} });
    const auth = createAuth({ db, config, logger, mailer: new ConsoleTransport() });

    console.log(`\n  creating ${COUNT} accounts against ${new URL(url).host}\n`);
    let made = 0;
    let existed = 0;

    // Modest concurrency: scrypt is deliberately expensive and this is a laptop.
    const BATCH = 8;
    for (let start = 0; start < COUNT; start += BATCH) {
      await Promise.all(
        Array.from({ length: Math.min(BATCH, COUNT - start) }, async (_, k) => {
          const i = start + k;
          const email = `${PREFIX}-${String(i).padStart(5, "0")}@example.test`;
          try {
            await auth.api.signUpEmail({
              body: { email, password: LOAD_PASSWORD, name: `Load ${i}` },
            });
            made++;
          } catch {
            existed++;
          }
        }),
      );
      if ((start + BATCH) % 200 === 0) console.log(`    ${start + BATCH}/${COUNT}`);
    }

    /*
     * Verified in bulk. The verification link is a stateless signed JWT with no
     * database write, so it is not what a crowd stresses — and these mailboxes
     * cannot receive anything anyway.
     */
    await db.execute(
      sql`UPDATE users SET email_verified = true WHERE email LIKE ${`${PREFIX}-%@example.test`}`,
    );

    const total = await db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM users WHERE email LIKE ${`${PREFIX}-%@example.test`}`,
    );

    console.log(`\n  created ${made}, already existed ${existed}`);
    console.log(`  load-test accounts now present: ${total.rows[0]?.n ?? 0}`);
    console.log(`  all verified, all @example.test (undeliverable by definition)\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Seeding failed:", error);
  process.exit(1);
});

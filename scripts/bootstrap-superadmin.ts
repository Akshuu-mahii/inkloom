/**
 * One-time super-admin bootstrap.
 *
 *   pnpm bootstrap:superadmin --email you@example.com
 *
 * This is the ONLY way the first `super_admin` comes into existence. There is
 * no public admin registration, no admin email hardcoded anywhere in the
 * application, and nothing in the client bundle that names an administrator.
 *
 * Deliberate constraints:
 *
 *   - The account must ALREADY EXIST and be email-verified. Bootstrapping does
 *     not create a user, so there is no path that mints a privileged account
 *     from nothing.
 *   - It refuses to run if a super_admin already exists, unless `--force` is
 *     passed with an explicit typed confirmation. Promotion after that point is
 *     an audited in-app action, not a shell command.
 *   - Every promotion writes an audit event with actor `system` and a reason,
 *     so the very first privileged act is as traceable as every later one.
 *   - It prints a reminder that 2FA enrolment is mandatory before the account
 *     can actually use any admin endpoint — `requirePermission` enforces that,
 *     so a bootstrapped admin without 2FA is inert until they enrol.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { eq, sql } from "drizzle-orm";
import { createDb } from "@inkloom/db/client";
import { newId, role as roleTable, user as userTable, userRole } from "@inkloom/db";
import { describeTarget, required } from "./_env";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  const force = process.argv.includes("--force");

  if (!email) {
    console.error("\n  Usage: pnpm bootstrap:superadmin --email you@example.com\n");
    process.exit(1);
  }

  const url = required("DATABASE_URL");
  const { db, pool } = createDb({ connectionString: url, max: 1 });

  try {
    console.log(`\n  Target: ${describeTarget(url)}`);

    const account = await db.query.user.findFirst({
      where: eq(userTable.normalizedEmail, email),
    });

    if (!account) {
      console.error(`\n  No account found for ${email}.`);
      console.error("  Sign up through the app first, then run this command.\n");
      process.exit(1);
    }

    if (!account.emailVerified) {
      console.error(`\n  ${email} exists but the address is not verified.`);
      console.error("  Verify it first — an unverified address is not proof of control.\n");
      process.exit(1);
    }

    if (account.status !== "active") {
      console.error(`\n  ${email} is ${account.status}. Refusing to promote.\n`);
      process.exit(1);
    }

    const existing = await db.execute<{ count: string; emails: string }>(sql`
      SELECT COUNT(*)::text AS count,
             COALESCE(string_agg(email, ', '), '') AS emails
      FROM users WHERE role = 'super_admin' AND status = 'active'
    `);
    const superAdminCount = Number(existing.rows[0]?.count ?? 0);

    if (superAdminCount > 0 && !force) {
      console.error(`\n  A super admin already exists (${existing.rows[0]?.emails}).`);
      console.error("  Promote further admins from /admin, where the action is audited.");
      console.error("  To override anyway, re-run with --force.\n");
      process.exit(1);
    }

    if (superAdminCount > 0 && force) {
      console.log(`\n  WARNING: ${superAdminCount} super admin(s) already exist.`);
      const rl = createInterface({ input: stdin, output: stdout });
      const answer = await rl.question(`  Type the email again (${email}) to confirm: `);
      rl.close();
      if (answer.trim().toLowerCase() !== email) {
        console.log("\n  Cancelled — nothing was changed.\n");
        process.exit(1);
      }
    }

    await db.transaction(async (tx) => {
      // Ensure the role rows exist even on a database that was never seeded.
      await tx.execute(sql`
        INSERT INTO roles (id, name, rank, description, permissions)
        VALUES
          (${newId("rol")}, 'user',        0,  'Ordinary account', '[]'::jsonb),
          (${newId("rol")}, 'support',     10, 'Front-line support', '[]'::jsonb),
          (${newId("rol")}, 'operations',  20, 'Operations and incident response', '[]'::jsonb),
          (${newId("rol")}, 'admin',       30, 'Administrator', '[]'::jsonb),
          (${newId("rol")}, 'super_admin', 40, 'Full control', '[]'::jsonb)
        ON CONFLICT (name) DO NOTHING
      `);

      const superRole = await tx.query.role.findFirst({
        where: eq(roleTable.name, "super_admin"),
      });
      if (!superRole) throw new Error("super_admin role missing after seeding");

      // The mirrored column Better Auth's admin plugin reads...
      await tx
        .update(userTable)
        .set({ role: "super_admin", updatedAt: new Date() })
        .where(eq(userTable.id, account.id));

      // ...and the authoritative, auditable grant record.
      await tx
        .insert(userRole)
        .values({
          id: newId("urol"),
          userId: account.id,
          roleId: superRole.id,
          grantedBy: null, // no prior admin existed to grant it
          reason: "Initial super-admin bootstrap (one-time CLI)",
        })
        .onConflictDoNothing();

      await tx.execute(sql`
        INSERT INTO audit_events (id, action, actor_type, actor_id, actor_role, target_type, target_id, reason, metadata)
        VALUES (
          ${newId("aud")}, 'system.bootstrap.super_admin', 'system', NULL, 'system',
          'user', ${account.id},
          'Initial super-admin bootstrap via one-time CLI',
          ${JSON.stringify({ email, forced: force, previousSuperAdmins: superAdminCount })}::jsonb
        )
      `);
    });

    console.log(`\n  ${email} is now a super admin.\n`);
    console.log("  Before this account can use ANY admin endpoint it must enrol in");
    console.log("  two-factor authentication at /app/security. Until then every");
    console.log("  admin request returns TWO_FACTOR_REQUIRED — that check is in");
    console.log("  middleware, so there is no way around it.\n");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Bootstrap failed:", error);
  process.exit(1);
});

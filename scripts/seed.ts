/**
 * Development seed.
 *
 *   pnpm db:seed
 *
 * Loads the reference data the application expects (roles, feature flags,
 * system settings) plus — ONLY outside production — a small set of obviously
 * fake accounts and the `INKLOOMHACKATHON` campaign.
 *
 * The reference data is idempotent and safe anywhere. The sample data is
 * refused outright when INKLOOM_ENV is production, so this script can never
 * put test users into a real database.
 */
import { sql } from "drizzle-orm";
import { createDb, type Database } from "@inkloom/db/client";
import { newId } from "@inkloom/db";
import { fingerprintCode, maskCode, normalizeCode } from "@inkloom/core/access-codes";
import { FEATURE_FLAGS, SYSTEM_SETTINGS } from "@inkloom/core/settings";
import { ROLE_PERMISSIONS, ROLE_RANK, ROLES } from "@inkloom/core/rbac";
import { describeTarget, optional, required } from "./_env";

const ROLE_DESCRIPTIONS: Record<string, string> = {
  user: "Ordinary Inkloom account",
  support: "Front-line support: read accounts, answer tickets",
  operations: "Operations and incident response: suspend, revoke, pause",
  admin: "Administrator: full read plus campaign lifecycle",
  super_admin: "Full control including credits, roles and emergency controls",
};

/** Reference data. Idempotent, and safe to run against any environment. */
async function seedReferenceData(db: Database) {
  for (const name of ROLES) {
    await db.execute(sql`
      INSERT INTO roles (id, name, rank, description, permissions)
      VALUES (
        ${newId("rol")}, ${name}, ${ROLE_RANK[name]},
        ${ROLE_DESCRIPTIONS[name] ?? name},
        ${JSON.stringify(ROLE_PERMISSIONS[name])}::jsonb
      )
      ON CONFLICT (name) DO UPDATE
        SET rank = EXCLUDED.rank,
            description = EXCLUDED.description,
            permissions = EXCLUDED.permissions,
            updated_at = now()
    `);
  }
  console.log(`  roles              ${ROLES.length} seeded`);

  for (const flag of Object.values(FEATURE_FLAGS)) {
    // DO NOTHING, not DO UPDATE: an operator who has turned a flag off must not
    // have it silently turned back on by a deploy running the seed.
    await db.execute(sql`
      INSERT INTO feature_flags (id, key, description, enabled, high_risk)
      VALUES (${newId("flag")}, ${flag.key}, ${flag.description}, ${flag.default}, ${flag.highRisk})
      ON CONFLICT (key) DO NOTHING
    `);
  }
  console.log(`  feature_flags      ${Object.keys(FEATURE_FLAGS).length} seeded`);

  for (const setting of Object.values(SYSTEM_SETTINGS)) {
    await db.execute(sql`
      INSERT INTO system_settings (id, key, value, description, high_risk)
      VALUES (
        ${newId("set")}, ${setting.key},
        ${JSON.stringify(setting.default)}::jsonb,
        ${setting.description}, ${setting.highRisk}
      )
      ON CONFLICT (key) DO NOTHING
    `);
  }
  console.log(`  system_settings    ${Object.keys(SYSTEM_SETTINGS).length} seeded`);
}

/** The launch campaign, created through the same fingerprinting path as the API. */
async function seedHackathonCampaign(db: Database, pepper: string) {
  const plaintext = "INKLOOMHACKATHON";
  const normalized = normalizeCode(plaintext);
  const fingerprint = await fingerprintCode(normalized, pepper);
  const { masked, last4 } = maskCode(normalized);

  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO access_code_campaigns
      (id, name, description, code_fingerprint, code_masked, code_last4,
       credit_amount, max_total_redemptions, max_redemptions_per_user,
       expires_at, target_cohort, status)
    VALUES (
      ${newId("cmp")},
      'Inkloom Hackathon Early Access',
      'Launch campaign for hackathon attendees. Seeded, not hardcoded in any route.',
      ${fingerprint}, ${masked}, ${last4},
      500, 2000, 1,
      ${new Date(Date.now() + 365 * 24 * 3600 * 1000)},
      'hackathon-2026',
      'enabled'
    )
    ON CONFLICT (code_fingerprint) DO NOTHING
    RETURNING id
  `);

  if (result.rows.length > 0) {
    console.log(`  campaign           INKLOOMHACKATHON -> ${masked} (500 credits)`);
  } else {
    console.log(`  campaign           INKLOOMHACKATHON already present (${masked})`);
  }
}

/**
 * Obviously-fake development accounts.
 *
 * `@example.test` is a reserved TLD that can never resolve, so none of these
 * can ever receive real mail. They have NO password set, so they cannot be
 * signed into — they exist to make the admin screens legible during
 * development, not to be used.
 */
async function seedSampleUsers(db: Database) {
  const samples = [
    {
      name: "Ada Lovelace",
      email: "ada@example.test",
      verified: true,
      status: "active",
      credits: 500,
    },
    {
      name: "Grace Hopper",
      email: "grace@example.test",
      verified: true,
      status: "active",
      credits: 250,
    },
    {
      name: "Alan Turing",
      email: "alan@example.test",
      verified: false,
      status: "active",
      credits: 0,
    },
    {
      name: "Spam Bot",
      email: "spam@example.test",
      verified: true,
      status: "suspended",
      credits: 0,
    },
  ];

  for (const sample of samples) {
    const userId = newId("usr");
    const inserted = await db.execute<{ id: string }>(sql`
      INSERT INTO users (id, name, email, email_verified, status, suspended_at, suspended_reason, early_access_joined_at)
      VALUES (
        ${userId}, ${sample.name}, ${sample.email}, ${sample.verified}, ${sample.status},
        ${sample.status === "suspended" ? new Date() : null},
        ${sample.status === "suspended" ? "Seeded example of a suspended account" : null},
        now()
      )
      ON CONFLICT (normalized_email) DO NOTHING
      RETURNING id
    `);

    const id = inserted.rows[0]?.id;
    if (!id) continue;

    const walletId = newId("wal");
    await db.execute(sql`
      INSERT INTO credit_wallets (id, user_id, balance) VALUES (${walletId}, ${id}, 0)
      ON CONFLICT (user_id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO notification_preferences (id, user_id) VALUES (${newId("npf")}, ${id})
      ON CONFLICT (user_id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO profiles (id, user_id, display_name) VALUES (${newId("prf")}, ${id}, ${sample.name})
      ON CONFLICT (user_id) DO NOTHING
    `);

    if (sample.credits > 0) {
      // Written through the ledger, not by setting a balance directly, so the
      // seed data satisfies the same invariant as real data and reconciliation
      // reports zero drift on a freshly seeded database.
      const entryId = newId("led");
      await db.execute(sql`
        INSERT INTO credit_ledger
          (id, user_id, wallet_id, amount, type, balance_after, reference_type,
           idempotency_key, actor_type, reason, metadata)
        VALUES (
          ${entryId}, ${id}, ${walletId}, ${sample.credits}, 'PROMOTIONAL_GRANT',
          ${sample.credits}, 'system_bootstrap', ${"seed_" + id}, 'system',
          'Development seed data', ${JSON.stringify({ seed: true })}::jsonb
        )
      `);
      await db.execute(sql`
        UPDATE credit_wallets
        SET balance = ${sample.credits}, version = 1, last_entry_id = ${entryId}
        WHERE id = ${walletId}
      `);
    }
  }
  console.log(`  sample users       ${samples.length} (all @example.test, no passwords)`);
}

async function main() {
  const url = required("DATABASE_URL");
  const env = optional("INKLOOM_ENV", "development");
  const pepper = required("ACCESS_CODE_PEPPER");

  const { db, pool } = createDb({ connectionString: url, max: 1 });

  try {
    console.log(`\n  Seeding ${describeTarget(url)} (${env})\n`);

    await seedReferenceData(db);

    if (env === "production") {
      console.log("\n  Production: reference data only. No sample users, no seeded campaign.");
      console.log("  Create the launch campaign with `pnpm codes:create` or from /admin.\n");
      return;
    }

    await seedHackathonCampaign(db, pepper);
    await seedSampleUsers(db);

    console.log("\n  Done.\n");
    console.log("  Next:");
    console.log("    1. Sign up at http://localhost:5173/auth/signup");
    console.log("    2. Read the verification mail at http://localhost:8025 (Mailpit)");
    console.log("    3. pnpm bootstrap:superadmin --email <your address>");
    console.log("    4. Enrol in 2FA at /app/security, then open /admin");
    console.log("    5. Redeem INKLOOMHACKATHON at /app/redeem for 500 credits\n");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});

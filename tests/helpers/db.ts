/**
 * Integration-test database helpers.
 *
 * Every test file gets a real connection to `inkloom_test` and truncates
 * between tests. Truncation order respects the append-only triggers: those
 * forbid DELETE, but TRUNCATE is a different operation and is permitted, which
 * is exactly why tests can reset while the application still cannot tamper.
 */
import { createDb, type Database } from "@inkloom/db/client";
import { newId } from "@inkloom/db";
import { sql } from "drizzle-orm";
import type pg from "pg";

const TABLES = [
  "analytics_events",
  "rate_limit_events",
  "abuse_flags",
  "security_events",
  "audit_events",
  "email_events",
  "notifications",
  "notification_preferences",
  "user_consents",
  "data_export_requests",
  "admin_notes",
  "support_requests",
  "idempotency_keys",
  "credit_ledger",
  "credit_wallets",
  "access_code_redemptions",
  "access_code_campaigns",
  "user_roles",
  "two_factor",
  "verification_tokens",
  "sessions",
  "accounts",
  "profiles",
  "users",
  "feature_flags",
  "system_settings",
] as const;

export interface TestDb {
  db: Database;
  pool: pg.Pool;
  truncate(): Promise<void>;
  close(): Promise<void>;
}

export function connectTestDb(): TestDb {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is not set");

  // A generous pool: the concurrency tests need many simultaneous connections
  // to produce genuine contention rather than accidental serialisation.
  const { db, pool } = createDb({ connectionString, max: 40 });

  return {
    db,
    pool,
    async truncate() {
      await db.execute(sql.raw(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`));
    },
    async close() {
      await pool.end();
    },
  };
}

/** Insert a user directly, bypassing Better Auth, for tests about other subsystems. */
export async function createTestUser(
  db: Database,
  overrides: Partial<{
    email: string;
    name: string;
    emailVerified: boolean;
    status: string;
    role: string;
  }> = {},
): Promise<{ id: string; email: string; normalizedEmail: string }> {
  const id = newId("usr");
  const email = overrides.email ?? `user-${id}@example.test`;
  const normalizedEmail = email.toLowerCase();

  const status = overrides.status ?? "active";
  // The `users_suspension_consistent` CHECK requires suspended_at whenever
  // status is 'suspended', so the helper must satisfy it like real code does.
  const suspendedAt = status === "suspended" ? new Date() : null;

  // `normalized_email` is a GENERATED column derived from `email`, so it is
  // never written explicitly — Postgres fills it in.
  await db.execute(sql`
    INSERT INTO users (id, name, email, email_verified, status, role, suspended_at)
    VALUES (
      ${id},
      ${overrides.name ?? "Test User"},
      ${email},
      ${overrides.emailVerified ?? true},
      ${status},
      ${overrides.role ?? "user"},
      ${suspendedAt}
    )
  `);

  return { id, email, normalizedEmail };
}

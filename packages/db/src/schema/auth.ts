import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, tsCol, updatedAt, userStatusEnum } from "./_shared";

/**
 * Better Auth owns the shape of `user`, `session`, `account`, `verification`
 * and `two_factor`. The property keys below (`user`, `session`, ...) are the
 * model names Better Auth's Drizzle adapter resolves against, so they must not
 * be renamed; the SQL table names are ours.
 *
 * Columns added by Inkloom are grouped and commented as such.
 */

export const user = pgTable(
  "users",
  {
    id: text("id").primaryKey(),

    // --- Better Auth core ---
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),

    // --- Better Auth admin plugin ---
    role: text("role").notNull().default("user"),
    banned: boolean("banned").notNull().default(false),
    banReason: text("ban_reason"),
    banExpires: tsCol("ban_expires"),

    // --- Better Auth two-factor plugin ---
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),

    // --- Inkloom ---
    /**
     * Case-folded email. Uniqueness is enforced on THIS column, not on `email`,
     * so `Ada@Inkloom.com` and `ada@inkloom.art` can never both exist.
     *
     * A GENERATED column, not an application-maintained one: Postgres derives it
     * from `email` on every insert and update, so it can never drift, no code
     * path can forget to update it, and Better Auth (which knows nothing about
     * it) does not need to write it.
     */
    normalizedEmail: text("normalized_email").generatedAlwaysAs(sql`lower(email)`),
    status: userStatusEnum("status").notNull().default("active"),
    suspendedAt: tsCol("suspended_at"),
    suspendedReason: text("suspended_reason"),
    /** Set when the user asks for deletion; the row is anonymised, never dropped. */
    deletionRequestedAt: tsCol("deletion_requested_at"),
    anonymizedAt: tsCol("anonymized_at"),
    lastLoginAt: tsCol("last_login_at"),
    /** Rotating keyed hash of the last login IP. The raw IP is never stored. */
    lastLoginIpHash: text("last_login_ip_hash"),
    earlyAccessJoinedAt: tsCol("early_access_joined_at"),
    /** First-touch attribution, captured at signup. Never contains PII. */
    signupUtm: jsonb("signup_utm").$type<Record<string, string>>(),
  },
  (t) => [
    // Case-insensitive uniqueness — the real constraint.
    uniqueIndex("users_normalized_email_key").on(t.normalizedEmail),
    index("users_status_idx").on(t.status),
    index("users_created_at_idx").on(t.createdAt.desc()),
    index("users_role_idx").on(t.role),
    index("users_email_verified_idx").on(t.emailVerified),
    check(
      "users_suspension_consistent",
      sql`
      (${t.status} <> 'suspended') OR (${t.suspendedAt} IS NOT NULL)
    `,
    ),
  ],
);

export const session = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    /**
     * Better Auth stores the session token here. It is generated with a CSPRNG
     * by the library and is the value carried in the `__Host-inkloom_session`
     * cookie. It is never logged, never returned by any API, and never rendered.
     */
    token: text("token").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: tsCol("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /**
     * Better Auth writes the request IP here. A database hook replaces it with
     * a rotating keyed hash before insert, so no raw IP reaches storage.
     */
    ipAddress: text("ip_address"),
    /** Coarse "Chrome on macOS" label, not the full UA string. */
    userAgent: text("user_agent"),
    /** Better Auth admin plugin: set while an admin is impersonating. */
    impersonatedBy: text("impersonated_by"),

    // --- Inkloom ---
    /** Absolute cutoff, independent of idle refresh. Enforced in middleware. */
    absoluteExpiresAt: tsCol("absolute_expires_at"),
    lastActiveAt: tsCol("last_active_at").notNull().defaultNow(),
    revokedAt: tsCol("revoked_at"),
    revokedReason: text("revoked_reason"),
  },
  (t) => [
    uniqueIndex("sessions_token_key").on(t.token),
    index("sessions_user_expires_idx").on(t.userId, t.expiresAt),
    index("sessions_expires_at_idx").on(t.expiresAt),
    index("sessions_user_last_active_idx").on(t.userId, t.lastActiveAt.desc()),
  ],
);

export const account = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: tsCol("access_token_expires_at"),
    refreshTokenExpiresAt: tsCol("refresh_token_expires_at"),
    scope: text("scope"),
    idToken: text("id_token"),
    /**
     * Better Auth's scrypt hash for the credential provider. Inkloom never
     * reads, returns, logs or exports this column; see the `admins_cannot_read`
     * assertions in the security test suite.
     */
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("accounts_provider_account_key").on(t.providerId, t.accountId),
    index("accounts_user_idx").on(t.userId),
  ],
);

/**
 * Better Auth's single-use token store. It backs BOTH email-verification and
 * password-reset tokens, distinguished by an identifier prefix
 * (`reset-password:<userId>` for resets). Migration 0001 adds a
 * `password_reset_tokens` view over this table for operators who expect that
 * name; see docs/DATABASE.md.
 */
export const verification = pgTable(
  "verification_tokens",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: tsCol("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("verification_identifier_idx").on(t.identifier),
    index("verification_expires_at_idx").on(t.expiresAt),
  ],
);

export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** TOTP shared secret, managed entirely by Better Auth. Never exposed. */
    secret: text("secret").notNull(),
    /** Hashed backup codes, managed entirely by Better Auth. Never exposed. */
    backupCodes: text("backup_codes").notNull(),
    /** Set once the user proves they can generate a valid TOTP code. */
    verified: boolean("verified").notNull().default(false),
    /** Drives Better Auth's own throttling of TOTP brute-force attempts. */
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: tsCol("locked_until"),
  },
  (t) => [index("two_factor_user_idx").on(t.userId)],
);

export const profile = pgTable(
  "profiles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    displayName: text("display_name"),
    /** Free-text, user-supplied. Rendered as text only, never as HTML. */
    company: text("company"),
    /** IANA zone, used only to format timestamps in email. */
    timezone: text("timezone"),
    locale: text("locale").notNull().default("en"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("profiles_user_key").on(t.userId)],
);

export const userRelations = relations(user, ({ one, many }) => ({
  profile: one(profile, { fields: [user.id], references: [profile.userId] }),
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const profileRelations = relations(profile, ({ one }) => ({
  user: one(user, { fields: [profile.userId], references: [user.id] }),
}));

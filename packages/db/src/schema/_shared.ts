import { sql } from "drizzle-orm";
import { pgEnum, timestamp } from "drizzle-orm/pg-core";

/** `timestamptz` everywhere. Postgres stores UTC; the app never guesses a zone. */
export const tsCol = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const createdAt = () => tsCol("created_at").notNull().defaultNow();
export const updatedAt = () =>
  tsCol("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const now = sql`now()`;

// ---------------------------------------------------------------------------
// Enums — status values are enforced by Postgres, not only by application code.
// ---------------------------------------------------------------------------

export const userStatusEnum = pgEnum("user_status", [
  "active",
  "suspended",
  "pending_deletion",
  "deleted",
]);

export const roleNameEnum = pgEnum("role_name", [
  "user",
  "support",
  "operations",
  "admin",
  "super_admin",
]);

export const campaignStatusEnum = pgEnum("campaign_status", [
  "enabled",
  "paused",
  "expired",
  "revoked",
]);

export const redemptionOutcomeEnum = pgEnum("redemption_outcome", [
  "granted",
  "duplicate",
  "limit_reached",
  "expired",
  "not_started",
  "paused",
  "revoked",
  "unknown_code",
  "domain_not_allowed",
  "email_unverified",
  "user_suspended",
  "rate_limited",
  "redemption_disabled",
]);

/**
 * Credit ledger entry types.
 *
 * V1-active types grant or remove promotional credit. The V2 types exist in the
 * enum so that adding payments and generation later is a code change, not a
 * destructive migration of a live ledger — but no V1 code path can emit them,
 * and `assertV1LedgerType` in @inkloom/core rejects them at the service edge.
 */
export const ledgerTypeEnum = pgEnum("ledger_type", [
  // --- active in V1 ---
  "EARLY_ACCESS_GRANT",
  "PROMOTIONAL_GRANT",
  "ADMIN_GRANT",
  "ADMIN_DEDUCTION",
  "EXPIRY",
  "REVERSAL",
  // --- reserved for V2, never written in V1 ---
  "PURCHASE",
  "GENERATION_RESERVE",
  "GENERATION_CAPTURE",
  "GENERATION_RELEASE",
  "PAYMENT_REFUND",
]);

export const ledgerActorEnum = pgEnum("ledger_actor_type", ["user", "admin", "system"]);

export const ledgerRefEnum = pgEnum("ledger_ref_type", [
  "access_code_redemption",
  "admin_adjustment",
  "reversal",
  "expiry_sweep",
  "system_bootstrap",
  // reserved for V2
  "payment",
  "generation",
]);

export const supportStatusEnum = pgEnum("support_status", [
  "open",
  "in_progress",
  "waiting_on_user",
  "resolved",
  "closed",
]);

export const supportPriorityEnum = pgEnum("support_priority", ["low", "normal", "high", "urgent"]);

export const supportCategoryEnum = pgEnum("support_category", [
  "account",
  "billing",
  "access_code",
  "bug",
  "feedback",
  "security",
  "other",
]);

export const securityEventTypeEnum = pgEnum("security_event_type", [
  "login_failed",
  "login_succeeded",
  "login_blocked_suspended",
  "login_new_device",
  "password_reset_requested",
  "password_reset_completed",
  "password_changed",
  "email_change_requested",
  "email_changed",
  "email_verification_sent",
  "email_verified",
  "session_revoked",
  "sessions_revoked_all",
  "rate_limit_exceeded",
  "turnstile_failed",
  "csrf_rejected",
  "origin_rejected",
  "access_code_failed",
  "access_code_abuse_suspected",
  "admin_login",
  "admin_2fa_failed",
  "admin_privilege_change",
  "account_suspended",
  "account_unsuspended",
  "account_deleted",
  // Added in 0005. A second factor being switched off is a common first move
  // after a takeover, so it belongs in the security trail, not just the audit.
  "two_factor_enabled",
  "two_factor_disabled",
  "credit_adjustment_suspicious",
  "unauthorized_admin_access",
  "data_export_requested",
]);

export const emailStatusEnum = pgEnum("email_status", [
  "queued",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
]);

export const consentTypeEnum = pgEnum("consent_type", [
  "terms",
  "privacy",
  "marketing_email",
  "product_analytics",
]);

export const notificationKindEnum = pgEnum("notification_kind", [
  "announcement",
  "security",
  "credits",
  "support",
  "account",
]);

export const exportStatusEnum = pgEnum("export_status", [
  "requested",
  "processing",
  "ready",
  "failed",
  "expired",
]);

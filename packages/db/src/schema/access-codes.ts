import { relations, sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { campaignStatusEnum, createdAt, tsCol, updatedAt } from "./_shared";
import { user } from "./auth";

/**
 * Access-code campaigns.
 *
 * A redeemable code is NEVER stored. On creation the plaintext is normalised
 * (upper-cased, separators stripped) and reduced to
 * `HMAC-SHA256(normalised, ACCESS_CODE_PEPPER)`, stored hex-encoded in
 * `codeFingerprint`. Redemption re-derives the same fingerprint and looks it
 * up, so a database dump yields no redeemable codes without the pepper, which
 * lives only in Cloudflare Secrets.
 *
 * `codeMasked` / `codeLast4` exist purely so an admin can recognise a campaign
 * in a list. The full code is shown exactly once, in the API response that
 * creates it, and is never recoverable afterwards.
 */
export const accessCodeCampaign = pgTable(
  "access_code_campaigns",
  {
    id: text("id").primaryKey(),

    name: text("name").notNull(),
    /** Internal only. Never returned on any user-facing endpoint. */
    description: text("description"),

    codeFingerprint: text("code_fingerprint").notNull(),
    codeMasked: text("code_masked").notNull(),
    codeLast4: text("code_last4").notNull(),

    creditAmount: integer("credit_amount").notNull(),

    maxTotalRedemptions: integer("max_total_redemptions"),
    maxRedemptionsPerUser: integer("max_redemptions_per_user").notNull().default(1),

    startsAt: tsCol("starts_at"),
    expiresAt: tsCol("expires_at"),

    status: campaignStatusEnum("status").notNull().default("enabled"),

    /**
     * Optional allowlist of verified email domains, lower-cased
     * (e.g. `["mitwpu.edu.in"]`). Null means any verified email is eligible.
     */
    allowedEmailDomains: jsonb("allowed_email_domains").$type<string[]>(),
    /** Free-form cohort tag used for reporting, e.g. "launch-2026". */
    targetCohort: text("target_cohort"),

    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),

    pausedAt: tsCol("paused_at"),
    revokedAt: tsCol("revoked_at"),
    revokedBy: text("revoked_by").references(() => user.id, { onDelete: "set null" }),
    revokedReason: text("revoked_reason"),

    /**
     * Denormalised counter. It is only ever incremented inside the same
     * transaction that inserts the redemption row, under a `SELECT ... FOR
     * UPDATE` on this row, so it cannot drift or over-issue under concurrency.
     */
    redemptionCount: integer("redemption_count").notNull().default(0),
    lastRedeemedAt: tsCol("last_redeemed_at"),
  },
  (t) => [
    uniqueIndex("campaigns_fingerprint_key").on(t.codeFingerprint),
    index("campaigns_status_expires_idx").on(t.status, t.expiresAt),
    index("campaigns_created_at_idx").on(t.createdAt.desc()),
    index("campaigns_cohort_idx").on(t.targetCohort),
    check("campaigns_credit_amount_positive", sql`${t.creditAmount} > 0`),
    check(
      "campaigns_max_total_positive",
      sql`${t.maxTotalRedemptions} IS NULL OR ${t.maxTotalRedemptions} > 0`,
    ),
    check("campaigns_per_user_positive", sql`${t.maxRedemptionsPerUser} > 0`),
    check("campaigns_count_non_negative", sql`${t.redemptionCount} >= 0`),
    check(
      "campaigns_window_ordered",
      sql`${t.startsAt} IS NULL OR ${t.expiresAt} IS NULL OR ${t.startsAt} < ${t.expiresAt}`,
    ),
    check(
      "campaigns_within_total_cap",
      sql`${t.maxTotalRedemptions} IS NULL OR ${t.redemptionCount} <= ${t.maxTotalRedemptions}`,
    ),
  ],
);

/**
 * Successful redemptions only. A failed attempt writes a `security_events` row
 * and a `rate_limit_events` row, never a redemption row — so this table stays a
 * clean accounting record that reconciles 1:1 with the credit ledger.
 */
export const accessCodeRedemption = pgTable(
  "access_code_redemptions",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => accessCodeCampaign.id, { onDelete: "restrict" }),
    /** `restrict`: a redemption is an accounting record and outlives the account. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    /**
     * 1-based occupancy slot for this (campaign, user) pair. A campaign with
     * `maxRedemptionsPerUser = 1` only ever has slot 1, which turns the unique
     * index below into "one redemption per user per campaign, enforced by
     * Postgres". A campaign allowing N per user fills slots 1..N; the Nth+1
     * concurrent attempt collides on an already-taken slot and rolls back.
     */
    slot: integer("slot").notNull().default(1),
    creditsGranted: integer("credits_granted").notNull(),
    /** Written inside the same transaction as the ledger entry it points at. */
    ledgerEntryId: text("ledger_entry_id"),
    /** Rotating keyed hash. Raw IPs are never stored. */
    ipHash: text("ip_hash"),
    /**
     * NAMED FOR ITS MEANING, STORED AS `created_at`.
     *
     * Correct through the query builder, which resolves the alias. A TRAP in raw
     * SQL: writing this property's snake_case spelling names a column that was
     * never created, and Postgres answers SQLSTATE 42703 at runtime rather than
     * anything at build time. The redemption replay path did exactly that and
     * returned a 500 on every duplicate redemption.
     *
     * `packages/db/src/__tests__/column-aliases.test.ts` derives these aliases
     * from this file and fails the build if any raw SQL reaches for the name
     * that does not exist.
     */
    redeemedAt: createdAt(),
  },
  (t) => [
    /**
     * THE concurrency guarantee.
     *
     * Even if two transactions both pass every application-level check, only
     * one can insert (campaign, user, slot). The loser fails on this constraint
     * and its entire transaction — including the credit grant — rolls back.
     * Covered by the mandatory concurrency test in
     * `packages/core/src/credits/__tests__/redemption.concurrency.test.ts`.
     */
    uniqueIndex("redemptions_campaign_user_slot_key").on(t.campaignId, t.userId, t.slot),
    index("redemptions_campaign_idx").on(t.campaignId, t.redeemedAt.desc()),
    index("redemptions_user_idx").on(t.userId, t.redeemedAt.desc()),
    check("redemptions_credits_positive", sql`${t.creditsGranted} > 0`),
    check("redemptions_slot_positive", sql`${t.slot} >= 1`),
  ],
);

export const campaignRelations = relations(accessCodeCampaign, ({ many, one }) => ({
  redemptions: many(accessCodeRedemption),
  creator: one(user, { fields: [accessCodeCampaign.createdBy], references: [user.id] }),
}));

export const redemptionRelations = relations(accessCodeRedemption, ({ one }) => ({
  campaign: one(accessCodeCampaign, {
    fields: [accessCodeRedemption.campaignId],
    references: [accessCodeCampaign.id],
  }),
  user: one(user, { fields: [accessCodeRedemption.userId], references: [user.id] }),
}));

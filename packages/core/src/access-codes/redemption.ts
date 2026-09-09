/**
 * Access-code redemption.
 *
 * The whole operation is one Postgres transaction. If any step fails, no
 * credits are granted — that is not a convention here, it is a rollback.
 *
 * Ordering matters and is deliberate:
 *
 *   1. Claim the idempotency key       (blocks a double-submit immediately)
 *   2. Lock the campaign row FOR UPDATE (serialises every redeemer of this code)
 *   3. Re-read campaign state under the lock
 *   4. Check window, status, global cap
 *   5. Check this user's prior redemptions
 *   6. Insert the redemption row       (unique index is the final backstop)
 *   7. Append the ledger entry + move the wallet (lock order: campaign -> wallet)
 *   8. Bump the campaign counter
 *   9. Write the audit event
 *  10. Commit
 *
 * Because every redeemer of a given code contends on the same campaign row,
 * step 2 turns concurrent redemption into a queue. Step 6 then catches any
 * scenario the application logic somehow missed. Both are proven by
 * `redemption.concurrency.test.ts`, which fires N simultaneous requests and
 * asserts exactly one redemption and exactly one ledger entry exist.
 */
import { eq, sql } from "drizzle-orm";
import type { Database } from "@inkloom/db/client";
import { accessCodeCampaign, accessCodeRedemption, newId } from "@inkloom/db";
import { fail } from "../util/errors";
import type { Logger } from "../util/logger";
import { type CreditService, isUniqueViolation } from "../credits/ledger";
import type { AuditService } from "../audit/audit";
import { fingerprintCode, isValidCodeShape, normalizeCode } from "./code";

export type RedemptionFailureReason =
  | "unknown_code"
  | "paused"
  | "revoked"
  | "expired"
  | "not_started"
  | "limit_reached"
  | "duplicate"
  | "domain_not_allowed"
  | "email_unverified"
  | "user_suspended"
  | "redemption_disabled"
  | "malformed";

export interface RedeemInput {
  userId: string;
  /** Raw text as typed. Normalised here, never trusted as-is. */
  code: string;
  idempotencyKey: string;
  ipHash?: string | null;
  requestId?: string;
}

export interface RedeemSuccess {
  campaignId: string;
  campaignName: string;
  creditsGranted: number;
  /** Authoritative post-transaction balance, read from the locked wallet row. */
  balance: number;
  ledgerEntryId: string;
  redemptionId: string;
  replayed: boolean;
}

export interface RedeemContext {
  /** From the database, never from the request body. */
  emailVerified: boolean;
  userStatus: string;
  normalizedEmail: string;
  /** From the `code_redemption_enabled` feature flag. */
  redemptionEnabled: boolean;
}

/**
 * Thrown for every business-rule failure. Carries the true reason for the
 * security log while the HTTP layer returns only the generic
 * "This code is invalid or unavailable." — the caller must not be able to
 * distinguish "no such code" from "campaign exhausted", which would let an
 * attacker map live campaigns.
 */
export class RedemptionError extends Error {
  constructor(
    readonly reason: RedemptionFailureReason,
    readonly campaignId: string | null = null,
  ) {
    super(`Redemption refused: ${reason}`);
    this.name = "RedemptionError";
  }
}

export class RedemptionService {
  constructor(
    private readonly db: Database,
    private readonly credits: CreditService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
    private readonly pepper: string,
  ) {}

  async redeem(input: RedeemInput, context: RedeemContext): Promise<RedeemSuccess> {
    // --- Preconditions that need no database work ---------------------------
    if (!context.redemptionEnabled) throw new RedemptionError("redemption_disabled");
    if (context.userStatus !== "active") throw new RedemptionError("user_suspended");
    // The brief requires a verified email before any credit can be granted.
    if (!context.emailVerified) throw new RedemptionError("email_unverified");

    const normalized = normalizeCode(input.code);
    if (!isValidCodeShape(normalized)) {
      // Shape failures are indistinguishable from unknown codes to the caller.
      throw new RedemptionError("malformed");
    }

    const fingerprint = await fingerprintCode(normalized, this.pepper);

    try {
      return await this.db.transaction(async (tx) => {
        // --- 1. Claim the idempotency key ---------------------------------
        await this.credits.claimIdempotencyKey(tx, {
          scope: "access_code.redeem",
          key: input.idempotencyKey,
          userId: input.userId,
          requestHash: fingerprint,
        });

        // --- 2/3. Lock the campaign row and re-read it under the lock ------
        // Every concurrent redeemer of this code queues here.
        const locked = await tx.execute<CampaignRow>(sql`
          SELECT id, name, status, credit_amount, max_total_redemptions,
                 max_redemptions_per_user, starts_at, expires_at,
                 allowed_email_domains, redemption_count, target_cohort
          FROM access_code_campaigns
          WHERE code_fingerprint = ${fingerprint}
          FOR UPDATE
        `);

        const campaign = locked.rows[0];
        if (!campaign) {
          // Logged at debug only: an unknown code is an ordinary typo far more
          // often than an attack, and the security_events row written by the
          // API layer is the durable record.
          this.logger.debug("redeem_unknown_fingerprint", { userId: input.userId });
          throw new RedemptionError("unknown_code");
        }

        // --- 4. Status, window and global cap -----------------------------
        assertCampaignRedeemable(campaign);

        // --- 4b. Cohort restriction ---------------------------------------
        const domains = campaign.allowed_email_domains;
        if (Array.isArray(domains) && domains.length > 0) {
          const domain = context.normalizedEmail.split("@")[1] ?? "";
          if (!domains.map((d) => d.toLowerCase()).includes(domain)) {
            throw new RedemptionError("domain_not_allowed", campaign.id);
          }
        }

        // --- 5. This user's prior redemptions ------------------------------
        const perUserCap = Number(campaign.max_redemptions_per_user);
        const priorCount = await tx.execute<{ count: string }>(sql`
          SELECT COUNT(*)::text AS count
          FROM access_code_redemptions
          WHERE campaign_id = ${campaign.id} AND user_id = ${input.userId}
        `);
        const alreadyRedeemed = Number(priorCount.rows[0]?.count ?? 0);
        if (alreadyRedeemed >= perUserCap) {
          throw new RedemptionError("duplicate", campaign.id);
        }

        // --- 6. Insert the redemption --------------------------------------
        // `slot` makes the unique index do the real work: even if two
        // transactions reached here together, only one can take slot N.
        const redemptionId = newId("rdm");
        const creditAmount = Number(campaign.credit_amount);

        await tx.insert(accessCodeRedemption).values({
          id: redemptionId,
          campaignId: campaign.id,
          userId: input.userId,
          slot: alreadyRedeemed + 1,
          creditsGranted: creditAmount,
          ipHash: input.ipHash ?? null,
        });

        // --- 7. Ledger entry + wallet (locks the wallet row) ----------------
        const entry = await this.credits.applyEntry(tx, {
          userId: input.userId,
          amount: creditAmount,
          type: "EARLY_ACCESS_GRANT",
          referenceType: "access_code_redemption",
          referenceId: redemptionId,
          idempotencyKey: input.idempotencyKey,
          actorType: "user",
          actorId: input.userId,
          reason: `Redeemed access code campaign "${campaign.name}"`,
          metadata: {
            campaignId: campaign.id,
            campaignName: campaign.name,
            redemptionId,
            cohort: campaign.target_cohort ?? undefined,
            requestId: input.requestId,
          },
        });

        await tx
          .update(accessCodeRedemption)
          .set({ ledgerEntryId: entry.id })
          .where(eq(accessCodeRedemption.id, redemptionId));

        // --- 8. Campaign counter, still under the row lock -----------------
        await tx
          .update(accessCodeCampaign)
          .set({
            redemptionCount: sql`${accessCodeCampaign.redemptionCount} + 1`,
            lastRedeemedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(accessCodeCampaign.id, campaign.id));

        await this.credits.completeIdempotencyKey(
          tx,
          "access_code.redeem",
          input.idempotencyKey,
          entry.id,
          { redemptionId, balance: entry.balanceAfter },
        );

        // --- 9. Audit ------------------------------------------------------
        await this.audit.record(tx, {
          action: "access_code.redeemed",
          actorType: "user",
          actorId: input.userId,
          targetType: "campaign",
          targetId: campaign.id,
          reason: null,
          metadata: {
            creditsGranted: creditAmount,
            redemptionId,
            ledgerEntryId: entry.id,
            balanceAfter: entry.balanceAfter,
          },
          requestId: input.requestId ?? null,
          ipHash: input.ipHash ?? null,
        });

        return {
          campaignId: campaign.id,
          campaignName: campaign.name,
          creditsGranted: creditAmount,
          balance: entry.balanceAfter,
          ledgerEntryId: entry.id,
          redemptionId,
          replayed: false,
        } satisfies RedeemSuccess;
      });
    } catch (error) {
      // A unique violation means we lost a race — either on the idempotency key
      // or on (campaign, user, slot). Both mean "someone already did this".
      if (isUniqueViolation(error)) {
        const replay = await this.findExistingRedemption(input.userId, fingerprint);
        if (replay) return replay;
        throw new RedemptionError("duplicate");
      }
      throw error;
    }
  }

  /**
   * A retry that lost the race gets the winner's result rather than an error,
   * so a double-click looks like one successful redemption to the user.
   */
  private async findExistingRedemption(
    userId: string,
    fingerprint: string,
  ): Promise<RedeemSuccess | null> {
    const found = await this.db.execute<{
      redemption_id: string;
      campaign_id: string;
      campaign_name: string;
      credits_granted: number;
      ledger_entry_id: string | null;
      balance: number;
    }>(sql`
      SELECT r.id AS redemption_id, c.id AS campaign_id, c.name AS campaign_name,
             r.credits_granted, r.ledger_entry_id, w.balance
      FROM access_code_redemptions r
      JOIN access_code_campaigns c ON c.id = r.campaign_id
      LEFT JOIN credit_wallets w ON w.user_id = r.user_id
      WHERE r.user_id = ${userId} AND c.code_fingerprint = ${fingerprint}
      ORDER BY r.redeemed_at DESC
      LIMIT 1
    `);

    const row = found.rows[0];
    if (!row) return null;

    return {
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      creditsGranted: Number(row.credits_granted),
      balance: Number(row.balance ?? 0),
      ledgerEntryId: row.ledger_entry_id ?? "",
      redemptionId: row.redemption_id,
      replayed: true,
    };
  }

  /** Map an internal failure reason onto the small set of safe client errors. */
  static toClientError(error: RedemptionError) {
    switch (error.reason) {
      case "duplicate":
        return fail("CODE_ALREADY_REDEEMED");
      case "redemption_disabled":
        return fail("CODE_REDEMPTION_DISABLED");
      case "email_unverified":
        return fail("EMAIL_NOT_VERIFIED");
      case "user_suspended":
        return fail("ACCOUNT_SUSPENDED");
      default:
        // unknown_code, expired, paused, revoked, limit_reached,
        // domain_not_allowed and malformed are all indistinguishable to the
        // caller. That is the point.
        return fail("CODE_UNAVAILABLE");
    }
  }
}

// `db.execute<T>` constrains T to a row shape, so the interface carries an
// index signature alongside its named columns.
interface CampaignRow extends Record<string, unknown> {
  id: string;
  name: string;
  status: string;
  credit_amount: number;
  max_total_redemptions: number | null;
  max_redemptions_per_user: number;
  starts_at: Date | null;
  expires_at: Date | null;
  allowed_email_domains: string[] | null;
  redemption_count: number;
  target_cohort: string | null;
}

/** Exported for unit testing without a database. */
export function assertCampaignRedeemable(
  campaign: Pick<
    CampaignRow,
    "id" | "status" | "starts_at" | "expires_at" | "max_total_redemptions" | "redemption_count"
  >,
  now: Date = new Date(),
): void {
  if (campaign.status === "paused") throw new RedemptionError("paused", campaign.id);
  if (campaign.status === "revoked") throw new RedemptionError("revoked", campaign.id);
  if (campaign.status === "expired") throw new RedemptionError("expired", campaign.id);

  if (campaign.starts_at && now < new Date(campaign.starts_at)) {
    throw new RedemptionError("not_started", campaign.id);
  }
  if (campaign.expires_at && now >= new Date(campaign.expires_at)) {
    throw new RedemptionError("expired", campaign.id);
  }
  if (
    campaign.max_total_redemptions !== null &&
    Number(campaign.redemption_count) >= Number(campaign.max_total_redemptions)
  ) {
    throw new RedemptionError("limit_reached", campaign.id);
  }
}

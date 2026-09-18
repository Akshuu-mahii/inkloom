/**
 * Account erasure, as a tombstone rather than a DELETE.
 *
 * WHY NOT `DELETE FROM users`
 * ---------------------------
 * It does not work, and it must not be made to work. Deleting a user cascades
 * `SET NULL` onto `audit_events.actor_id`, and `audit_events` is append-only —
 * the trigger rejects the UPDATE, so the delete fails the moment an account has
 * done anything auditable:
 *
 *   UPDATE on audit_events is forbidden: this table is append-only.
 *
 * The obvious "fix" is to drop the trigger for the duration of a deletion. That
 * would mean any code path able to delete a user is also able to rewrite the
 * audit trail, which defeats the entire point of having one. The trail exists to
 * record what staff did; a mechanism for erasing it on demand is not a trail.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * The stable internal id survives, because immutable history references it. The
 * person does not. Every piece of identifying data is destroyed or overwritten,
 * every credential and session is deleted, and the account is marked `deleted`
 * so nothing can authenticate as it again. Afterwards the id is an opaque
 * number that resolves to a tombstone: the ledger still balances, the audit
 * trail is still complete, and neither can name a human being.
 *
 * WHAT DELIBERATELY SURVIVES
 * --------------------------
 *  - `audit_events` and `credit_ledger`, untouched. Both are append-only and
 *    both are financial or accountability records.
 *  - `credit_wallets.balance`, untouched. The wallet is the running total of
 *    an immutable ledger; zeroing it would manufacture exactly the drift the
 *    reconciliation job exists to detect.
 *  - `access_code_redemptions`, which is a redemption record tied to the
 *    ledger. It holds an id and a keyed IP hash, no identifying data.
 *  - `user_consents`, the record that consent was given — the evidence for a
 *    lawful basis, which is not something to destroy on request. Its IP hash is
 *    cleared.
 *
 * KNOWN RESIDUAL
 * --------------
 * If a staff member typed an email address into an audit `reason` or a ledger
 * `metadata` field, it stays, because those rows cannot be rewritten. That is a
 * write-time discipline problem, not something erasure can reach, and it is
 * recorded here so nobody assumes this function is a complete guarantee.
 */
import { eq, like, or, sql } from "drizzle-orm";
import type { Database } from "@inkloom/db/client";
import {
  account as accountTable,
  analyticsEvent,
  emailEvent,
  notification,
  profile,
  rateLimitEvent,
  securityEvent,
  session as sessionTable,
  supportRequest,
  twoFactor,
  user as userTable,
  userConsent,
  verification,
} from "@inkloom/db";
import type { AuditService } from "../audit/audit";
import type { Logger } from "../util/logger";

/** Non-routable by RFC 2606, and unique per account so the index still holds. */
export const tombstoneEmail = (userId: string) => `deleted-${userId}@deleted.invalid`;

export const TOMBSTONE_NAME = "Deleted account";

export interface AnonymiseResult {
  userId: string;
  /** Row counts per table, for the audit record and for tests to assert on. */
  removed: Record<string, number>;
  anonymizedAt: Date;
}

export interface AnonymiseOptions {
  userId: string;
  /** "user" for self-service erasure, "admin" when staff act on a request. */
  actorType: "user" | "admin" | "system";
  actorId?: string | null;
  reason?: string;
  requestId?: string | null;
  ipHash?: string | null;
}

/**
 * Erase an account. Irreversible, and atomic.
 *
 * Everything happens in ONE transaction: a partial erasure — credentials gone
 * but the address still present, or the reverse — is worse than either outcome,
 * because it leaves an account that cannot be used and cannot be finished
 * either. If any step fails, nothing is erased and the caller gets an error.
 */
export async function anonymiseAccount(
  db: Database,
  audit: AuditService,
  logger: Logger,
  options: AnonymiseOptions,
): Promise<AnonymiseResult> {
  const { userId } = options;
  const anonymizedAt = new Date();

  return db.transaction(async (tx) => {
    const target = await tx.query.user.findFirst({ where: eq(userTable.id, userId) });
    if (!target) throw new Error(`No such account: ${userId}`);
    if (target.anonymizedAt) {
      throw new Error(`Account already erased: ${userId}`);
    }

    const email = target.email.toLowerCase();
    const removed: Record<string, number> = {};
    const count = (result: { rowCount?: number | null }) => result.rowCount ?? 0;

    // --- 1. Authentication capability ------------------------------------
    // Credentials first. If the transaction fails after this point nothing is
    // committed, but ordering it first keeps the intent legible: the very first
    // thing erasure does is make the account unusable.
    removed.accounts = count(await tx.delete(accountTable).where(eq(accountTable.userId, userId)));
    removed.sessions = count(await tx.delete(sessionTable).where(eq(sessionTable.userId, userId)));
    removed.two_factor = count(await tx.delete(twoFactor).where(eq(twoFactor.userId, userId)));

    /*
     * Outstanding reset and verification tokens.
     *
     * Both shapes matter: Better Auth stores the user id in `value` for a
     * password reset, and the email address in `identifier` for a verification.
     * Leaving either behind would hand someone a working link to an account
     * that is supposed to be gone.
     */
    removed.verification_tokens = count(
      await tx
        .delete(verification)
        .where(or(eq(verification.value, userId), like(verification.identifier, `%${email}%`))),
    );

    // --- 2. Identifying data on the account itself -----------------------
    // `normalized_email` is GENERATED from `email`, so it follows this write
    // automatically and cannot be left pointing at the old address.
    await tx
      .update(userTable)
      .set({
        name: TOMBSTONE_NAME,
        email: tombstoneEmail(userId),
        emailVerified: false,
        image: null,
        role: "user",
        banned: false,
        banReason: null,
        banExpires: null,
        twoFactorEnabled: false,
        status: "deleted",
        suspendedReason: null,
        lastLoginIpHash: null,
        signupUtm: null,
        deletionRequestedAt: target.deletionRequestedAt ?? anonymizedAt,
        anonymizedAt,
      })
      .where(eq(userTable.id, userId));

    // --- 3. Dependent personal data --------------------------------------
    removed.profiles = count(await tx.delete(profile).where(eq(profile.userId, userId)));
    removed.notifications = count(
      await tx.delete(notification).where(eq(notification.userId, userId)),
    );

    /*
     * Support correspondence is scrubbed rather than deleted.
     *
     * The ticket is an operational record — "we answered 400 tickets last
     * quarter" must stay true — but every field a person wrote is theirs. The
     * row keeps its id, timestamps and category and loses everything else.
     */
    removed.support_requests = count(
      await tx
        .update(supportRequest)
        .set({
          email: tombstoneEmail(userId),
          name: null,
          subject: "[erased]",
          message: "[erased at the account holder's request]",
          context: {},
          ipHash: null,
          resolutionNote: null,
        })
        .where(eq(supportRequest.userId, userId)),
    );

    /*
     * Security events keep their type, severity and keyed IP hash — the abuse
     * signal — and lose the address and user agent, which identify a person and
     * a device. The opaque user id stays so correlation still works.
     */
    removed.security_events = count(
      await tx
        .update(securityEvent)
        .set({ targetEmail: null, userAgent: null })
        .where(or(eq(securityEvent.userId, userId), eq(securityEvent.targetEmail, email))),
    );

    removed.email_events = count(
      await tx
        .update(emailEvent)
        .set({ toEmail: tombstoneEmail(userId), metadata: {} })
        .where(eq(emailEvent.userId, userId)),
    );

    /*
     * Analytics become genuinely anonymous rather than pseudonymous: dropping
     * the user id is what makes the remaining row untraceable, and the privacy
     * page already describes this data as pseudonymous throughout.
     */
    removed.analytics_events = count(
      await tx
        .update(analyticsEvent)
        .set({ userId: null })
        .where(eq(analyticsEvent.userId, userId)),
    );

    removed.user_consents = count(
      await tx.update(userConsent).set({ ipHash: null }).where(eq(userConsent.userId, userId)),
    );

    /*
     * Rate-limit counters keyed by address.
     *
     * `rate_limit_events.subject` literally stores `email:someone@example.com`,
     * so these rows are personal data hiding in an operational table. Both the
     * email-keyed and user-keyed subjects go.
     */
    removed.rate_limit_events = count(
      await tx
        .delete(rateLimitEvent)
        .where(
          or(eq(rateLimitEvent.subject, `email:${email}`), eq(rateLimitEvent.subject, `user:${userId}`)),
        ),
    );

    // Export payloads are a complete copy of everything held about a person.
    removed.data_export_requests = Number(
      (
        await tx.execute<{ n: string }>(sql`
          WITH cleared AS (
            UPDATE data_export_requests SET payload = NULL, status = 'expired'
             WHERE user_id = ${userId} RETURNING 1
          ) SELECT COUNT(*)::text AS n FROM cleared
        `)
      ).rows[0]?.n ?? 0,
    );

    // Staff notes are written ABOUT the person and have no purpose once the
    // account is gone.
    removed.admin_notes = Number(
      (
        await tx.execute<{ n: string }>(sql`
          WITH deleted AS (
            DELETE FROM admin_notes
             WHERE subject_type = 'user' AND subject_id = ${userId} RETURNING 1
          ) SELECT COUNT(*)::text AS n FROM deleted
        `)
      ).rows[0]?.n ?? 0,
    );

    removed.idempotency_keys = Number(
      (
        await tx.execute<{ n: string }>(sql`
          WITH deleted AS (
            DELETE FROM idempotency_keys WHERE user_id = ${userId} RETURNING 1
          ) SELECT COUNT(*)::text AS n FROM deleted
        `)
      ).rows[0]?.n ?? 0,
    );

    /*
     * --- 4. Record the erasure itself ------------------------------------
     *
     * Inside the transaction, so an erasure that is not audited does not
     * happen. This is an INSERT, which append-only permits; nothing here
     * rewrites an existing row.
     *
     * The audit row names the opaque id and NOT the address that was erased —
     * writing the old email here would put the identity straight back into a
     * table that can never be rewritten.
     */
    await audit.record(tx, {
      action: "user.account.erased",
      actorType: options.actorType,
      actorId: options.actorId ?? null,
      targetType: "user",
      targetId: userId,
      reason: options.reason ?? "Account erasure requested",
      requestId: options.requestId ?? null,
      ipHash: options.ipHash ?? null,
      metadata: { removed },
    });

    logger.info("account_erased", { userId, removed });

    return { userId, removed, anonymizedAt };
  });
}

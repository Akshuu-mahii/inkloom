/**
 * Admin API.
 *
 * Every route below is gated by `requirePermission(...)`, which reads the
 * caller's role from the DATABASE, enforces mandatory 2FA for staff, and
 * demands a recent authentication for anything that moves money or privilege.
 * There is no route here that a `user` role can reach, and no check that a
 * client can influence.
 *
 * The router is additionally guarded at mount time by `requirePermission`
 * ("admin.access"), so a new route added without its own gate still cannot be
 * reached by an ordinary user — defence against the most likely future mistake.
 */
import { Hono } from "hono";
import { and, count, desc, eq, gte, ilike, isNull, lt, or, sql } from "drizzle-orm";
import {
  abuseFlag,
  accessCodeCampaign,
  accessCodeRedemption,
  adminNote,
  auditEvent,
  creditLedger,
  emailEvent,
  newId,
  securityEvent,
  session as sessionTable,
  supportRequest,
  user as userTable,
} from "@inkloom/db";
import { displayDeviceLabel } from "@inkloom/core/auth";
import {
  fingerprintCode,
  generateCode,
  isValidCodeShape,
  maskCode,
  normalizeCode,
} from "@inkloom/core/access-codes";
import { FEATURE_FLAGS, SYSTEM_SETTINGS } from "@inkloom/core/settings";
import { templates } from "@inkloom/email";
import type { Env } from "../context";
import { apiError, ok, paged } from "../lib/response";
import { body, query, validateBody, validateQuery } from "../middleware/validate";
import { assertReason, requirePermission } from "../middleware/auth";
import { bySubjectUser, rateLimit } from "../middleware/rate-limit";
import {
  adjustCreditsSchema,
  adminUserListSchema,
  auditQuerySchema,
  campaignActionSchema,
  createCampaignSchema,
  emergencySchema,
  ledgerQuerySchema,
  reverseCreditsSchema,
  securityQuerySchema,
  supportQuerySchema,
  suspendUserSchema,
  unsuspendUserSchema,
  updateCampaignSchema,
  updateSettingsSchema,
  type AdjustCreditsInput,
  type CreateCampaignInput,
  type EmergencyInput,
  type UpdateSettingsInput,
} from "../schemas/index";

export const adminRoutes = new Hono<Env>();

/**
 * Blanket gate. Every specific route adds its own, narrower permission.
 *
 * Order is deliberate: authorize BEFORE metering. Rate limiting an
 * unauthenticated caller would let an anonymous prober fill a staff account's
 * bucket and lock the real operator out of their own console — a denial of
 * service handed over for free. Only calls that have already proven they are
 * the owner, hold the role, and carry a second factor are counted.
 */
adminRoutes.use("*", requirePermission("admin.access"));
adminRoutes.use("*", rateLimit({ bucket: "admin.api.user", subject: bySubjectUser }));

// ===========================================================================
// Overview
// ===========================================================================
adminRoutes.get("/overview", requirePermission("admin.overview.read"), async (c) => {
  const { db } = c.get("services");
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);

  // One round trip rather than fifteen: this page is opened often and each
  // sub-query is cheap and indexed.
  const stats = await db.execute<Record<string, string>>(sql`
    SELECT
      (SELECT COUNT(*) FROM users WHERE status <> 'deleted')                        AS total_users,
      (SELECT COUNT(*) FROM users WHERE email_verified = true AND status <> 'deleted') AS verified_users,
      (SELECT COUNT(*) FROM users WHERE created_at >= ${dayAgo})                    AS signups_today,
      (SELECT COUNT(*) FROM users WHERE created_at >= ${weekAgo})                   AS signups_week,
      (SELECT COUNT(*) FROM users WHERE created_at >= ${monthAgo})                  AS signups_month,
      (SELECT COUNT(*) FROM users WHERE status = 'suspended')                       AS suspended_users,
      (SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > now()) AS active_sessions,
      (SELECT COALESCE(SUM(amount),0) FROM credit_ledger WHERE amount > 0)          AS credits_granted,
      (SELECT COALESCE(SUM(balance),0) FROM credit_wallets)                         AS credits_outstanding,
      (SELECT COUNT(*) FROM access_code_redemptions)                                AS successful_redemptions,
      (SELECT COUNT(*) FROM security_events WHERE type = 'access_code_failed' AND created_at >= ${weekAgo}) AS blocked_redemptions,
      (SELECT COUNT(*) FROM access_code_campaigns WHERE status = 'enabled')         AS active_campaigns,
      (SELECT COUNT(*) FROM email_events WHERE status IN ('failed','bounced') AND created_at >= ${dayAgo}) AS email_failures,
      (SELECT COUNT(*) FROM support_requests WHERE status = 'open')                 AS open_support,
      (SELECT COUNT(*) FROM security_events WHERE severity = 'critical' AND created_at >= ${dayAgo}) AS critical_events
  `);

  const row = stats.rows[0] ?? {};
  const n = (key: string) => Number(row[key] ?? 0);

  const [byCampaign, recentSecurity, recentAdmin, funnel] = await Promise.all([
    db
      .select({
        campaignId: accessCodeCampaign.id,
        name: accessCodeCampaign.name,
        redemptions: accessCodeCampaign.redemptionCount,
        creditAmount: accessCodeCampaign.creditAmount,
        status: accessCodeCampaign.status,
      })
      .from(accessCodeCampaign)
      .orderBy(desc(accessCodeCampaign.redemptionCount))
      .limit(10),
    db.query.securityEvent.findMany({
      orderBy: [desc(securityEvent.createdAt)],
      limit: 10,
    }),
    db.query.auditEvent.findMany({ orderBy: [desc(auditEvent.createdAt)], limit: 10 }),
    // The GTM funnel the brief asks for, computed from first-party events.
    db.execute<Record<string, string>>(sql`
      SELECT
        (SELECT COUNT(DISTINCT anonymous_id) FROM analytics_events WHERE name = 'landing_viewed')  AS visitors,
        (SELECT COUNT(*) FROM analytics_events WHERE name = 'signup_started')                      AS signup_started,
        (SELECT COUNT(*) FROM users)                                                               AS signup_completed,
        (SELECT COUNT(*) FROM users WHERE email_verified = true)                                   AS email_verified,
        (SELECT COUNT(DISTINCT user_id) FROM access_code_redemptions)                              AS code_redeemed,
        (SELECT COUNT(DISTINCT user_id) FROM analytics_events WHERE name = 'dashboard_viewed')     AS dashboard_activated
    `),
  ]);

  const f = funnel.rows[0] ?? {};

  return ok(c, {
    users: {
      total: n("total_users"),
      verified: n("verified_users"),
      suspended: n("suspended_users"),
      signupsToday: n("signups_today"),
      signupsWeek: n("signups_week"),
      signupsMonth: n("signups_month"),
    },
    sessions: { active: n("active_sessions") },
    credits: {
      granted: n("credits_granted"),
      outstanding: n("credits_outstanding"),
      byCampaign,
    },
    redemptions: {
      successful: n("successful_redemptions"),
      blocked: n("blocked_redemptions"),
      activeCampaigns: n("active_campaigns"),
    },
    operations: {
      emailFailures: n("email_failures"),
      openSupport: n("open_support"),
      criticalSecurityEvents: n("critical_events"),
      status: n("critical_events") > 0 || n("email_failures") > 10 ? "degraded" : "healthy",
    },
    funnel: {
      visitors: Number(f.visitors ?? 0),
      signupStarted: Number(f.signup_started ?? 0),
      signupCompleted: Number(f.signup_completed ?? 0),
      emailVerified: Number(f.email_verified ?? 0),
      codeRedeemed: Number(f.code_redeemed ?? 0),
      dashboardActivated: Number(f.dashboard_activated ?? 0),
    },
    recentSecurityEvents: recentSecurity.map(serialiseSecurityEvent),
    recentAdminActions: recentAdmin.map((a) => ({
      id: a.id,
      action: a.action,
      actorId: a.actorId,
      targetType: a.targetType,
      targetId: a.targetId,
      reason: a.reason,
      createdAt: a.createdAt,
    })),
  });
});

// ===========================================================================
// Users
// ===========================================================================
adminRoutes.get(
  "/users",
  requirePermission("users.read"),
  validateQuery(adminUserListSchema),
  async (c) => {
    const { db } = c.get("services");
    const q = query<{
      limit: number;
      cursor?: string;
      q?: string;
      status?: string;
      verified?: string;
      role?: string;
      signedUpAfter?: string;
      signedUpBefore?: string;
    }>(c);

    const filters = [];
    if (q.q) {
      const term = `%${q.q.trim()}%`;
      filters.push(
        or(
          ilike(userTable.normalizedEmail, term.toLowerCase()),
          ilike(userTable.name, term),
          eq(userTable.id, q.q.trim()),
        ),
      );
    }
    if (q.status) filters.push(eq(userTable.status, q.status as "active"));
    if (q.verified) filters.push(eq(userTable.emailVerified, q.verified === "true"));
    if (q.role) filters.push(eq(userTable.role, q.role));
    if (q.signedUpAfter) filters.push(gte(userTable.createdAt, new Date(q.signedUpAfter)));
    if (q.signedUpBefore) filters.push(lt(userTable.createdAt, new Date(q.signedUpBefore)));
    if (q.cursor) filters.push(lt(userTable.createdAt, new Date(q.cursor)));

    const rows = await db
      .select({
        id: userTable.id,
        email: userTable.email,
        name: userTable.name,
        emailVerified: userTable.emailVerified,
        role: userTable.role,
        status: userTable.status,
        twoFactorEnabled: userTable.twoFactorEnabled,
        createdAt: userTable.createdAt,
        lastLoginAt: userTable.lastLoginAt,
      })
      .from(userTable)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(userTable.createdAt))
      .limit(q.limit + 1);

    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;

    return ok(c, paged(page, hasMore ? (page.at(-1)?.createdAt.toISOString() ?? null) : null));
  },
);

adminRoutes.get("/users/:id", requirePermission("users.read"), async (c) => {
  const { db, credits } = c.get("services");
  const userId = c.req.param("id");

  const account = await db.query.user.findFirst({ where: eq(userTable.id, userId) });
  if (!account) throw apiError("NOT_FOUND");

  const [wallet, ledger, redemptions, sessions, events, notes] = await Promise.all([
    credits.getBalance(userId),
    db.query.creditLedger.findMany({
      where: eq(creditLedger.userId, userId),
      orderBy: [desc(creditLedger.createdAt)],
      limit: 50,
    }),
    db
      .select({
        id: accessCodeRedemption.id,
        campaignName: accessCodeCampaign.name,
        creditsGranted: accessCodeRedemption.creditsGranted,
        redeemedAt: accessCodeRedemption.redeemedAt,
      })
      .from(accessCodeRedemption)
      .innerJoin(accessCodeCampaign, eq(accessCodeCampaign.id, accessCodeRedemption.campaignId))
      .where(eq(accessCodeRedemption.userId, userId)),
    db.query.session.findMany({
      where: and(eq(sessionTable.userId, userId), isNull(sessionTable.revokedAt)),
      limit: 20,
    }),
    db.query.securityEvent.findMany({
      where: eq(securityEvent.userId, userId),
      orderBy: [desc(securityEvent.createdAt)],
      limit: 25,
    }),
    db.query.adminNote.findMany({
      where: and(eq(adminNote.subjectType, "user"), eq(adminNote.subjectId, userId)),
      orderBy: [desc(adminNote.createdAt)],
      limit: 50,
    }),
  ]);

  /**
   * Explicit field selection, not a row spread.
   *
   * The brief forbids admins from ever seeing passwords, password hashes, raw
   * session tokens, reset tokens or authentication secrets. The password hash
   * lives on `accounts`, which is NOT queried here at all; session TOKENS are
   * excluded from the session projection below; and because this object is
   * built field by field, adding a sensitive column to a table later cannot
   * silently start leaking it through this endpoint.
   */
  return ok(c, {
    user: {
      id: account.id,
      email: account.email,
      name: account.name,
      emailVerified: account.emailVerified,
      role: account.role,
      status: account.status,
      twoFactorEnabled: account.twoFactorEnabled,
      createdAt: account.createdAt,
      lastLoginAt: account.lastLoginAt,
      suspendedAt: account.suspendedAt,
      suspendedReason: account.suspendedReason,
      earlyAccessJoinedAt: account.earlyAccessJoinedAt,
      anonymizedAt: account.anonymizedAt,
    },
    credits: {
      balance: wallet.balance,
      ledger: ledger.map((e) => ({
        id: e.id,
        amount: e.amount,
        type: e.type,
        balanceAfter: e.balanceAfter,
        reason: e.reason,
        actorType: e.actorType,
        actorId: e.actorId,
        createdAt: e.createdAt,
      })),
    },
    redemptions,
    sessions: sessions.map((s) => ({
      id: s.id,
      // Device label only. `s.token` is never selected or serialised.
      // Stored pre-labelled by the session-create hook; do not re-parse.
      device: displayDeviceLabel(s.userAgent),
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      expiresAt: s.expiresAt,
    })),
    securityEvents: events.map(serialiseSecurityEvent),
    notes: notes.map((n) => ({
      id: n.id,
      body: n.body,
      authorId: n.authorId,
      createdAt: n.createdAt,
    })),
  });
});

adminRoutes.post(
  "/users/:id/suspend",
  requirePermission("users.suspend"),
  validateBody(suspendUserSchema),
  async (c) => {
    const admin = c.get("principal")!;
    const { db, audit, mailer, config } = c.get("services");
    const userId = c.req.param("id");
    const input = body<{ reason: string; revokeSessions: boolean }>(c);
    const reason = assertReason("users.suspend", input.reason);

    const target = await db.query.user.findFirst({ where: eq(userTable.id, userId) });
    if (!target) throw apiError("NOT_FOUND");

    // An admin cannot suspend themselves out of the platform, and cannot
    // suspend someone of equal or higher rank — otherwise a compromised admin
    // account could disable the super-admin who would stop them.
    if (target.id === admin.userId) {
      throw apiError("VALIDATION_ERROR", {
        details: { reason: "You cannot suspend your own account." },
      });
    }
    if (target.role !== "user" && admin.role !== "super_admin") {
      throw apiError("FORBIDDEN", {
        details: { reason: "Only a super admin can suspend a staff account." },
      });
    }

    await db.transaction(async (tx) => {
      await tx
        .update(userTable)
        .set({
          status: "suspended",
          suspendedAt: new Date(),
          suspendedReason: reason,
          banned: true,
          banReason: reason,
        })
        .where(eq(userTable.id, userId));

      if (input.revokeSessions) {
        await tx
          .update(sessionTable)
          .set({ revokedAt: new Date(), revokedReason: "account_suspended" })
          .where(eq(sessionTable.userId, userId));
      }

      await audit.record(tx, {
        action: "admin.user.suspend",
        actorType: "admin",
        actorId: admin.userId,
        actorRole: admin.role,
        targetType: "user",
        targetId: userId,
        reason,
        metadata: { revokedSessions: input.revokeSessions, previousStatus: target.status },
        requestId: c.get("requestId"),
        ipHash: c.get("ipHash"),
      });
    });

    await audit.security({
      type: "account_suspended",
      severity: "warning",
      userId,
      requestId: c.get("requestId"),
      metadata: { by: admin.userId },
    });

    await mailer.send({
      to: target.email,
      template: "account_suspended",
      userId,
      force: true,
      rendered: templates.accountSuspended(
        { appUrl: config.APP_URL, supportEmail: config.SUPPORT_EMAIL },
        { name: target.name, reason },
      ),
    });

    return ok(c, { success: true });
  },
);

adminRoutes.post(
  "/users/:id/unsuspend",
  requirePermission("users.suspend"),
  validateBody(unsuspendUserSchema),
  async (c) => {
    const admin = c.get("principal")!;
    const { db, audit, mailer, config } = c.get("services");
    const userId = c.req.param("id");
    const reason = assertReason("users.suspend", body<{ reason: string }>(c).reason);

    const target = await db.query.user.findFirst({ where: eq(userTable.id, userId) });
    if (!target) throw apiError("NOT_FOUND");
    // A deleted account is not resurrectable — that would undo an anonymisation.
    if (target.status === "deleted") {
      throw apiError("VALIDATION_ERROR", {
        details: { reason: "A deleted account cannot be restored." },
      });
    }

    await db.transaction(async (tx) => {
      await tx
        .update(userTable)
        .set({
          status: "active",
          suspendedAt: null,
          suspendedReason: null,
          banned: false,
          banReason: null,
        })
        .where(eq(userTable.id, userId));

      await audit.record(tx, {
        action: "admin.user.unsuspend",
        actorType: "admin",
        actorId: admin.userId,
        actorRole: admin.role,
        targetType: "user",
        targetId: userId,
        reason,
        requestId: c.get("requestId"),
        ipHash: c.get("ipHash"),
      });
    });

    await audit.security({ type: "account_unsuspended", userId, requestId: c.get("requestId") });

    await mailer.send({
      to: target.email,
      template: "account_restored",
      userId,
      force: true,
      rendered: templates.accountRestored(
        { appUrl: config.APP_URL, supportEmail: config.SUPPORT_EMAIL },
        { name: target.name },
      ),
    });

    return ok(c, { success: true });
  },
);

adminRoutes.post(
  "/users/:id/revoke-sessions",
  requirePermission("users.revoke_sessions"),
  async (c) => {
    const admin = c.get("principal")!;
    const { db, audit } = c.get("services");
    const userId = c.req.param("id");

    const result = await db
      .update(sessionTable)
      .set({ revokedAt: new Date(), revokedReason: "admin_revoked" })
      .where(and(eq(sessionTable.userId, userId), isNull(sessionTable.revokedAt)))
      .returning({ id: sessionTable.id });

    await audit.recordStandalone({
      action: "admin.user.revoke_sessions",
      actorType: "admin",
      actorId: admin.userId,
      actorRole: admin.role,
      targetType: "user",
      targetId: userId,
      metadata: { revoked: result.length },
      requestId: c.get("requestId"),
      ipHash: c.get("ipHash"),
    });

    return ok(c, { revoked: result.length });
  },
);

adminRoutes.post("/users/:id/notes", requirePermission("users.note"), async (c) => {
  const admin = c.get("principal")!;
  const { db } = c.get("services");
  const userId = c.req.param("id");
  const { note } = (await c.req.json().catch(() => ({}))) as { note?: string };

  if (!note?.trim() || note.length > 2000) {
    throw apiError("VALIDATION_ERROR", {
      details: { note: "Write between 1 and 2000 characters." },
    });
  }

  const id = newId("note");
  await db.insert(adminNote).values({
    id,
    subjectType: "user",
    subjectId: userId,
    authorId: admin.userId,
    body: note.trim(),
  });

  return ok(c, { id });
});

// ===========================================================================
// Access-code campaigns
// ===========================================================================
adminRoutes.get("/access-codes", requirePermission("codes.read"), async (c) => {
  const { db } = c.get("services");

  const rows = await db
    .select({
      id: accessCodeCampaign.id,
      name: accessCodeCampaign.name,
      description: accessCodeCampaign.description,
      // The MASKED value only. `codeFingerprint` is never selected: it is the
      // one field that, with the pepper, could be brute-forced back to a code.
      codeMasked: accessCodeCampaign.codeMasked,
      creditAmount: accessCodeCampaign.creditAmount,
      status: accessCodeCampaign.status,
      redemptionCount: accessCodeCampaign.redemptionCount,
      maxTotalRedemptions: accessCodeCampaign.maxTotalRedemptions,
      maxRedemptionsPerUser: accessCodeCampaign.maxRedemptionsPerUser,
      startsAt: accessCodeCampaign.startsAt,
      expiresAt: accessCodeCampaign.expiresAt,
      lastRedeemedAt: accessCodeCampaign.lastRedeemedAt,
      targetCohort: accessCodeCampaign.targetCohort,
      createdAt: accessCodeCampaign.createdAt,
      createdBy: accessCodeCampaign.createdBy,
    })
    .from(accessCodeCampaign)
    .orderBy(desc(accessCodeCampaign.createdAt))
    .limit(100);

  return ok(c, { campaigns: rows });
});

adminRoutes.post(
  "/access-codes",
  requirePermission("codes.create"),
  validateBody(createCampaignSchema),
  async (c) => {
    const admin = c.get("principal")!;
    const { db, config, audit, settings } = c.get("services");
    const input = body<CreateCampaignInput>(c);
    const reason = assertReason("codes.create", input.reason);

    if (!(await settings.isEnabled("promotional_grants_enabled"))) {
      throw apiError("FEATURE_DISABLED", {
        details: { reason: "Promotional grants are paused." },
      });
    }

    // Either the admin supplies a code, or we generate a strong one.
    const plaintext = input.code?.trim() ? input.code.trim() : generateCode();
    const normalized = normalizeCode(plaintext);

    if (!isValidCodeShape(normalized)) {
      throw apiError("VALIDATION_ERROR", {
        details: { code: "Use 6-64 letters and digits. Hyphens and spaces are ignored." },
      });
    }

    const fingerprint = await fingerprintCode(normalized, config.ACCESS_CODE_PEPPER);
    const { masked, last4 } = maskCode(normalized);

    const existing = await db.query.accessCodeCampaign.findFirst({
      where: eq(accessCodeCampaign.codeFingerprint, fingerprint),
    });
    if (existing) {
      throw apiError("CONFLICT", { details: { code: "That code is already in use." } });
    }

    const id = newId("cmp");

    await db.transaction(async (tx) => {
      await tx.insert(accessCodeCampaign).values({
        id,
        name: input.name,
        description: input.description ?? null,
        // Only the keyed fingerprint reaches storage. The plaintext exists
        // solely in this request and in the response below.
        codeFingerprint: fingerprint,
        codeMasked: masked,
        codeLast4: last4,
        creditAmount: input.creditAmount,
        maxTotalRedemptions: input.maxTotalRedemptions ?? null,
        maxRedemptionsPerUser: input.maxRedemptionsPerUser,
        startsAt: input.startsAt ? new Date(input.startsAt) : null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        allowedEmailDomains: input.allowedEmailDomains ?? null,
        targetCohort: input.targetCohort ?? null,
        createdBy: admin.userId,
      });

      await audit.record(tx, {
        action: "admin.campaign.create",
        actorType: "admin",
        actorId: admin.userId,
        actorRole: admin.role,
        targetType: "campaign",
        targetId: id,
        reason,
        // The audit trail records the MASKED code, never the plaintext.
        metadata: {
          name: input.name,
          creditAmount: input.creditAmount,
          codeMasked: masked,
          maxTotalRedemptions: input.maxTotalRedemptions ?? null,
        },
        requestId: c.get("requestId"),
        ipHash: c.get("ipHash"),
      });
    });

    return ok(c, {
      id,
      name: input.name,
      /**
       * The one and only time the full code is ever returned.
       *
       * It is not recoverable afterwards — only the HMAC fingerprint is stored,
       * and reversing that would require the pepper AND a brute-force search.
       * The UI says so explicitly next to this value.
       */
      code: plaintext,
      codeRevealedOnce: true,
      codeMasked: masked,
      creditAmount: input.creditAmount,
    });
  },
);

adminRoutes.get("/access-codes/:id", requirePermission("codes.read"), async (c) => {
  const { db } = c.get("services");
  const id = c.req.param("id");

  const campaign = await db.query.accessCodeCampaign.findFirst({
    where: eq(accessCodeCampaign.id, id),
  });
  if (!campaign) throw apiError("NOT_FOUND");

  const [redemptions, failures] = await Promise.all([
    db
      .select({
        id: accessCodeRedemption.id,
        userId: accessCodeRedemption.userId,
        email: userTable.email,
        creditsGranted: accessCodeRedemption.creditsGranted,
        redeemedAt: accessCodeRedemption.redeemedAt,
      })
      .from(accessCodeRedemption)
      .innerJoin(userTable, eq(userTable.id, accessCodeRedemption.userId))
      .where(eq(accessCodeRedemption.campaignId, id))
      .orderBy(desc(accessCodeRedemption.redeemedAt))
      .limit(200),
    // Suspicious attempts against this campaign.
    db.query.securityEvent.findMany({
      where: eq(securityEvent.type, "access_code_failed"),
      orderBy: [desc(securityEvent.createdAt)],
      limit: 50,
    }),
  ]);

  return ok(c, {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      description: campaign.description,
      codeMasked: campaign.codeMasked,
      codeLast4: campaign.codeLast4,
      creditAmount: campaign.creditAmount,
      status: campaign.status,
      redemptionCount: campaign.redemptionCount,
      maxTotalRedemptions: campaign.maxTotalRedemptions,
      maxRedemptionsPerUser: campaign.maxRedemptionsPerUser,
      startsAt: campaign.startsAt,
      expiresAt: campaign.expiresAt,
      allowedEmailDomains: campaign.allowedEmailDomains,
      targetCohort: campaign.targetCohort,
      createdAt: campaign.createdAt,
      createdBy: campaign.createdBy,
      revokedAt: campaign.revokedAt,
      revokedReason: campaign.revokedReason,
      // `codeFingerprint` is deliberately absent from this response.
    },
    redemptions,
    creditsIssued: campaign.redemptionCount * campaign.creditAmount,
    suspiciousAttempts: failures
      .filter((f) => (f.metadata as { campaignId?: string })?.campaignId === id)
      .map(serialiseSecurityEvent),
  });
});

adminRoutes.patch(
  "/access-codes/:id",
  requirePermission("codes.update"),
  validateBody(updateCampaignSchema),
  async (c) => {
    const admin = c.get("principal")!;
    const { db, audit } = c.get("services");
    const id = c.req.param("id");
    const input = body<Record<string, unknown>>(c);

    const campaign = await db.query.accessCodeCampaign.findFirst({
      where: eq(accessCodeCampaign.id, id),
    });
    if (!campaign) throw apiError("NOT_FOUND");
    if (campaign.status === "revoked") {
      throw apiError("CONFLICT", { details: { reason: "A revoked campaign cannot be edited." } });
    }

    await db.transaction(async (tx) => {
      await tx
        .update(accessCodeCampaign)
        .set({
          ...(input.name !== undefined ? { name: input.name as string } : {}),
          ...(input.description !== undefined
            ? { description: input.description as string | null }
            : {}),
          ...(input.maxTotalRedemptions !== undefined
            ? { maxTotalRedemptions: input.maxTotalRedemptions as number | null }
            : {}),
          ...(input.expiresAt !== undefined
            ? { expiresAt: input.expiresAt ? new Date(input.expiresAt as string) : null }
            : {}),
          ...(input.targetCohort !== undefined
            ? { targetCohort: input.targetCohort as string | null }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(accessCodeCampaign.id, id));

      await audit.record(tx, {
        action: "admin.campaign.update",
        actorType: "admin",
        actorId: admin.userId,
        actorRole: admin.role,
        targetType: "campaign",
        targetId: id,
        metadata: { changed: Object.keys(input) },
        requestId: c.get("requestId"),
        ipHash: c.get("ipHash"),
      });
    });

    return ok(c, { success: true });
  },
);

for (const action of ["pause", "revoke"] as const) {
  adminRoutes.post(
    `/access-codes/:id/${action}`,
    requirePermission(action === "pause" ? "codes.pause" : "codes.revoke"),
    validateBody(campaignActionSchema),
    async (c) => {
      const admin = c.get("principal")!;
      const { db, audit } = c.get("services");
      const id = c.req.param("id");
      const reason = assertReason(
        action === "pause" ? "codes.pause" : "codes.revoke",
        body<{ reason: string }>(c).reason,
      );

      const campaign = await db.query.accessCodeCampaign.findFirst({
        where: eq(accessCodeCampaign.id, id),
      });
      if (!campaign) throw apiError("NOT_FOUND");

      // Revocation is terminal by design: a revoked code must never come back,
      // because the reason for revoking is usually that it leaked.
      if (campaign.status === "revoked") {
        throw apiError("CONFLICT", {
          details: { reason: "This campaign is already revoked. Revocation is permanent." },
        });
      }

      await db.transaction(async (tx) => {
        await tx
          .update(accessCodeCampaign)
          .set(
            action === "pause"
              ? {
                  status: campaign.status === "paused" ? "enabled" : "paused",
                  pausedAt: campaign.status === "paused" ? null : new Date(),
                  updatedAt: new Date(),
                }
              : {
                  status: "revoked",
                  revokedAt: new Date(),
                  revokedBy: admin.userId,
                  revokedReason: reason,
                  updatedAt: new Date(),
                },
          )
          .where(eq(accessCodeCampaign.id, id));

        await audit.record(tx, {
          action: `admin.campaign.${action}`,
          actorType: "admin",
          actorId: admin.userId,
          actorRole: admin.role,
          targetType: "campaign",
          targetId: id,
          reason,
          metadata: { previousStatus: campaign.status },
          requestId: c.get("requestId"),
          ipHash: c.get("ipHash"),
        });
      });

      return ok(c, { success: true });
    },
  );
}

// ===========================================================================
// Credits
// ===========================================================================
adminRoutes.post(
  "/credits/adjust",
  requirePermission("credits.adjust"),
  validateBody(adjustCreditsSchema),
  async (c) => {
    const admin = c.get("principal")!;
    const { db, credits, audit, mailer, config, settings } = c.get("services");
    const input = body<AdjustCreditsInput>(c);
    const reason = assertReason("credits.adjust", input.reason);

    const target = await db.query.user.findFirst({ where: eq(userTable.id, input.userId) });
    if (!target) throw apiError("NOT_FOUND");

    if (input.amount > 0 && !(await settings.isEnabled("promotional_grants_enabled"))) {
      throw apiError("FEATURE_DISABLED", {
        details: { reason: "Promotional grants are paused." },
      });
    }

    // A large adjustment is recorded as a security event before it is applied,
    // so an anomalous grant is visible even if it succeeds.
    if (Math.abs(input.amount) >= 10_000) {
      await audit.security({
        type: "credit_adjustment_suspicious",
        severity: "warning",
        userId: input.userId,
        requestId: c.get("requestId"),
        metadata: { amount: input.amount, adminId: admin.userId },
      });
    }

    const before = await credits.getBalance(input.userId);

    const { entry, replayed } = await credits.adminAdjust({
      userId: input.userId,
      amount: input.amount,
      reason,
      adminId: admin.userId,
      idempotencyKey: input.idempotencyKey ?? newId("idem"),
      requestId: c.get("requestId"),
    });

    if (!replayed) {
      await audit.recordStandalone({
        action: "admin.credits.adjust",
        actorType: "admin",
        actorId: admin.userId,
        actorRole: admin.role,
        targetType: "user",
        targetId: input.userId,
        reason,
        // Before AND after, so the audit trail is self-contained.
        metadata: {
          amount: input.amount,
          balanceBefore: before.balance,
          balanceAfter: entry.balanceAfter,
          ledgerEntryId: entry.id,
        },
        requestId: c.get("requestId"),
        ipHash: c.get("ipHash"),
      });

      if (input.amount > 0) {
        await mailer.send({
          to: target.email,
          template: "credits_granted",
          userId: target.id,
          rendered: templates.creditsGranted(
            { appUrl: config.APP_URL, supportEmail: config.SUPPORT_EMAIL },
            {
              name: target.name,
              credits: input.amount,
              balance: entry.balanceAfter,
              reason,
            },
          ),
        });
      }
    }

    return ok(c, {
      ledgerEntryId: entry.id,
      balanceBefore: before.balance,
      balanceAfter: entry.balanceAfter,
      replayed,
    });
  },
);

adminRoutes.post(
  "/credits/reverse",
  requirePermission("credits.reverse"),
  validateBody(reverseCreditsSchema),
  async (c) => {
    const admin = c.get("principal")!;
    const { credits, audit } = c.get("services");
    const input = body<{ entryId: string; reason: string; idempotencyKey?: string }>(c);
    const reason = assertReason("credits.reverse", input.reason);

    // Appends a compensating entry; the original is never touched — a database
    // trigger makes that impossible, not merely discouraged.
    const { entry, replayed } = await credits.reverse({
      entryId: input.entryId,
      reason,
      adminId: admin.userId,
      idempotencyKey: input.idempotencyKey ?? newId("idem"),
    });

    if (!replayed) {
      await audit.recordStandalone({
        action: "admin.credits.reverse",
        actorType: "admin",
        actorId: admin.userId,
        actorRole: admin.role,
        targetType: "ledger_entry",
        targetId: input.entryId,
        reason,
        metadata: { reversalEntryId: entry.id, amount: entry.amount },
        requestId: c.get("requestId"),
        ipHash: c.get("ipHash"),
      });
    }

    return ok(c, { ledgerEntryId: entry.id, balanceAfter: entry.balanceAfter, replayed });
  },
);

adminRoutes.get(
  "/credits/ledger",
  requirePermission("credits.read"),
  validateQuery(ledgerQuerySchema),
  async (c) => {
    const { db } = c.get("services");
    const q = query<{ limit: number; cursor?: string; userId?: string; type?: string }>(c);

    const filters = [];
    if (q.userId) filters.push(eq(creditLedger.userId, q.userId));
    if (q.type) filters.push(eq(creditLedger.type, q.type as "ADMIN_GRANT"));
    if (q.cursor) filters.push(lt(creditLedger.createdAt, new Date(q.cursor)));

    const rows = await db
      .select({
        id: creditLedger.id,
        userId: creditLedger.userId,
        email: userTable.email,
        amount: creditLedger.amount,
        type: creditLedger.type,
        balanceAfter: creditLedger.balanceAfter,
        reason: creditLedger.reason,
        actorType: creditLedger.actorType,
        actorId: creditLedger.actorId,
        createdAt: creditLedger.createdAt,
      })
      .from(creditLedger)
      .innerJoin(userTable, eq(userTable.id, creditLedger.userId))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(creditLedger.createdAt))
      .limit(q.limit + 1);

    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;

    return ok(c, paged(page, hasMore ? (page.at(-1)?.createdAt.toISOString() ?? null) : null));
  },
);

adminRoutes.post("/credits/reconcile", requirePermission("credits.reconcile"), async (c) => {
  const admin = c.get("principal")!;
  const { credits, audit } = c.get("services");
  const repair = new URL(c.req.url).searchParams.get("repair") === "true";

  // Only a super admin may REPAIR; anyone with the permission may inspect.
  if (repair && admin.role !== "super_admin") {
    throw apiError("FORBIDDEN", {
      details: { reason: "Only a super admin can repair wallet balances." },
    });
  }

  const result = await credits.reconcile({ repair });

  await audit.recordStandalone({
    action: repair ? "admin.credits.reconcile_repair" : "admin.credits.reconcile",
    actorType: "admin",
    actorId: admin.userId,
    actorRole: admin.role,
    metadata: {
      checked: result.checked,
      drifted: result.drifted.length,
      repaired: result.repaired,
    },
    requestId: c.get("requestId"),
    ipHash: c.get("ipHash"),
  });

  return ok(c, result);
});

// ===========================================================================
// Audit, security, support
// ===========================================================================
adminRoutes.get(
  "/audit",
  requirePermission("audit.read"),
  validateQuery(auditQuerySchema),
  async (c) => {
    const { db } = c.get("services");
    const q = query<{
      limit: number;
      cursor?: string;
      action?: string;
      actorId?: string;
      targetId?: string;
    }>(c);

    const filters = [];
    if (q.action) filters.push(eq(auditEvent.action, q.action));
    if (q.actorId) filters.push(eq(auditEvent.actorId, q.actorId));
    if (q.targetId) filters.push(eq(auditEvent.targetId, q.targetId));
    if (q.cursor) filters.push(lt(auditEvent.createdAt, new Date(q.cursor)));

    const rows = await db.query.auditEvent.findMany({
      where: filters.length ? and(...filters) : undefined,
      orderBy: [desc(auditEvent.createdAt)],
      limit: q.limit + 1,
    });

    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;

    return ok(c, paged(page, hasMore ? (page.at(-1)?.createdAt.toISOString() ?? null) : null));
  },
);

adminRoutes.get(
  "/security",
  requirePermission("security.read"),
  validateQuery(securityQuerySchema),
  async (c) => {
    const { db } = c.get("services");
    const q = query<{
      limit: number;
      cursor?: string;
      type?: string;
      severity?: string;
      userId?: string;
    }>(c);

    const filters = [];
    if (q.type) filters.push(eq(securityEvent.type, q.type as "login_failed"));
    if (q.severity) filters.push(eq(securityEvent.severity, q.severity));
    if (q.userId) filters.push(eq(securityEvent.userId, q.userId));
    if (q.cursor) filters.push(lt(securityEvent.createdAt, new Date(q.cursor)));

    const [rows, flags, limits] = await Promise.all([
      db.query.securityEvent.findMany({
        where: filters.length ? and(...filters) : undefined,
        orderBy: [desc(securityEvent.createdAt)],
        limit: q.limit + 1,
      }),
      db.query.abuseFlag.findMany({ orderBy: [desc(abuseFlag.createdAt)], limit: 50 }),
      db.execute<Record<string, string>>(sql`
        SELECT bucket, COUNT(*)::text AS blocked
        FROM rate_limit_events
        WHERE blocked = true AND window_start >= now() - interval '24 hours'
        GROUP BY bucket ORDER BY 2 DESC LIMIT 20
      `),
    ]);

    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;

    return ok(c, {
      ...paged(
        page.map(serialiseSecurityEvent),
        hasMore ? (page.at(-1)?.createdAt.toISOString() ?? null) : null,
      ),
      abuseFlags: flags,
      rateLimitBlocks: limits.rows,
    });
  },
);

adminRoutes.get(
  "/support",
  requirePermission("support.read"),
  validateQuery(supportQuerySchema),
  async (c) => {
    const { db } = c.get("services");
    const q = query<{ limit: number; cursor?: string; status?: string; priority?: string }>(c);

    const filters = [];
    if (q.status) filters.push(eq(supportRequest.status, q.status as "open"));
    if (q.priority) filters.push(eq(supportRequest.priority, q.priority as "normal"));
    if (q.cursor) filters.push(lt(supportRequest.createdAt, new Date(q.cursor)));

    const rows = await db.query.supportRequest.findMany({
      where: filters.length ? and(...filters) : undefined,
      orderBy: [desc(supportRequest.createdAt)],
      limit: q.limit + 1,
    });

    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;

    return ok(c, paged(page, hasMore ? (page.at(-1)?.createdAt.toISOString() ?? null) : null));
  },
);

adminRoutes.patch("/support/:id", requirePermission("support.respond"), async (c) => {
  const admin = c.get("principal")!;
  const { db, audit } = c.get("services");
  const id = c.req.param("id");
  const payload = (await c.req.json().catch(() => ({}))) as {
    status?: string;
    priority?: string;
    resolutionNote?: string;
  };

  const allowedStatus = ["open", "in_progress", "waiting_on_user", "resolved", "closed"];
  if (payload.status && !allowedStatus.includes(payload.status)) {
    throw apiError("VALIDATION_ERROR", { details: { status: "Unknown status." } });
  }

  await db
    .update(supportRequest)
    .set({
      ...(payload.status ? { status: payload.status as "open" } : {}),
      ...(payload.priority ? { priority: payload.priority as "normal" } : {}),
      ...(payload.resolutionNote !== undefined
        ? { resolutionNote: payload.resolutionNote.slice(0, 2000) }
        : {}),
      ...(payload.status === "resolved"
        ? { resolvedAt: new Date(), resolvedBy: admin.userId }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(supportRequest.id, id));

  await audit.recordStandalone({
    action: "admin.support.update",
    actorType: "admin",
    actorId: admin.userId,
    actorRole: admin.role,
    targetType: "support_request",
    targetId: id,
    metadata: { status: payload.status, priority: payload.priority },
    requestId: c.get("requestId"),
    ipHash: c.get("ipHash"),
  });

  return ok(c, { success: true });
});

// ===========================================================================
// Settings, feature flags, emergency controls
// ===========================================================================
adminRoutes.get("/settings", requirePermission("settings.read"), async (c) => {
  const { settings } = c.get("services");
  return ok(c, {
    flags: await settings.allFlags(),
    settings: await settings.allSettings(),
    definitions: {
      flags: Object.values(FEATURE_FLAGS),
      settings: Object.values(SYSTEM_SETTINGS).map((s) => ({
        key: s.key,
        description: s.description,
        highRisk: s.highRisk,
      })),
    },
  });
});

adminRoutes.patch(
  "/settings",
  requirePermission("settings.write"),
  validateBody(updateSettingsSchema),
  async (c) => {
    const admin = c.get("principal")!;
    const { db, settings, audit } = c.get("services");
    const input = body<UpdateSettingsInput>(c);
    const reason = assertReason("settings.write", input.reason);

    // Any high-risk key demands an explicit typed confirmation on top of the
    // recent-authentication requirement `requirePermission` already imposed.
    const touchingHighRisk =
      Object.keys(input.flags ?? {}).some(
        (k) => FEATURE_FLAGS[k as keyof typeof FEATURE_FLAGS]?.highRisk,
      ) ||
      Object.keys(input.settings ?? {}).some(
        (k) => SYSTEM_SETTINGS[k as keyof typeof SYSTEM_SETTINGS]?.highRisk,
      );

    if (touchingHighRisk && input.confirmation !== "I UNDERSTAND") {
      throw apiError("VALIDATION_ERROR", {
        details: {
          confirmation: 'This change affects a high-risk setting. Type "I UNDERSTAND" to confirm.',
        },
      });
    }

    await db.transaction(async (tx) => {
      for (const [key, value] of Object.entries(input.flags ?? {})) {
        await settings.setFlag(tx, key, value, admin.userId);
      }
      for (const [key, value] of Object.entries(input.settings ?? {})) {
        await settings.set(tx, key, value, admin.userId);
      }

      await audit.record(tx, {
        action: "admin.settings.update",
        actorType: "admin",
        actorId: admin.userId,
        actorRole: admin.role,
        targetType: "system",
        reason,
        metadata: {
          flags: input.flags ?? {},
          settingKeys: Object.keys(input.settings ?? {}),
          highRisk: touchingHighRisk,
        },
        requestId: c.get("requestId"),
        ipHash: c.get("ipHash"),
      });
    });

    settings.invalidate();
    return ok(c, { success: true });
  },
);

adminRoutes.post(
  "/system/emergency",
  requirePermission("system.emergency"),
  validateBody(emergencySchema),
  async (c) => {
    const admin = c.get("principal")!;
    const { db, settings, audit } = c.get("services");
    const input = body<EmergencyInput>(c);
    const reason = assertReason("system.emergency", input.reason);

    // The confirmation must be the action's own name — impossible to trip
    // accidentally, and unambiguous in the audit log.
    if (input.confirmation !== input.action) {
      throw apiError("VALIDATION_ERROR", {
        details: { confirmation: `Type "${input.action}" exactly to confirm.` },
      });
    }

    let affected = 0;

    await db.transaction(async (tx) => {
      switch (input.action) {
        case "logout_all_users": {
          // Raise the epoch rather than deleting rows: it is instant, atomic,
          // and leaves the session history intact for the investigation that
          // usually follows an emergency logout.
          const epochs = await settings.get("session_epoch");
          await settings.set(
            tx,
            "session_epoch",
            { ...epochs, users: new Date().toISOString() },
            admin.userId,
          );
          const revoked = await tx
            .update(sessionTable)
            .set({ revokedAt: new Date(), revokedReason: "emergency_logout" })
            .where(isNull(sessionTable.revokedAt))
            .returning({ id: sessionTable.id });
          affected = revoked.length;
          break;
        }
        case "logout_all_admins": {
          const epochs = await settings.get("session_epoch");
          await settings.set(
            tx,
            "session_epoch",
            { ...epochs, admins: new Date().toISOString() },
            admin.userId,
          );
          // Every staff session EXCEPT the acting super-admin's own, so the
          // person handling the incident is not locked out mid-response.
          const revoked = await tx.execute<{ id: string }>(sql`
            UPDATE sessions SET revoked_at = now(), revoked_reason = 'emergency_admin_logout'
            WHERE revoked_at IS NULL
              AND id <> ${admin.sessionId}
              AND user_id IN (SELECT id FROM users WHERE role <> 'user')
            RETURNING id
          `);
          affected = revoked.rows.length;
          break;
        }
        case "pause_signups":
          await settings.setFlag(tx, "signup_enabled", false, admin.userId);
          break;
        case "pause_redemption":
          await settings.setFlag(tx, "code_redemption_enabled", false, admin.userId);
          break;
      }

      await audit.record(tx, {
        action: `admin.emergency.${input.action}`,
        actorType: "admin",
        actorId: admin.userId,
        actorRole: admin.role,
        targetType: "system",
        reason,
        metadata: { affected },
        requestId: c.get("requestId"),
        ipHash: c.get("ipHash"),
      });
    });

    await audit.security({
      type: "admin_privilege_change",
      severity: "critical",
      userId: admin.userId,
      requestId: c.get("requestId"),
      metadata: { emergencyAction: input.action, affected, reason },
    });

    settings.invalidate();
    return ok(c, { success: true, action: input.action, affected });
  },
);

// ===========================================================================
// System health (admin view — richer than the public probe)
// ===========================================================================
adminRoutes.get("/system", requirePermission("settings.read"), async (c) => {
  const { db, config } = c.get("services");

  const [emailStats, drift, dbLatency] = await Promise.all([
    db
      .select({ status: emailEvent.status, count: count() })
      .from(emailEvent)
      .where(gte(emailEvent.createdAt, new Date(Date.now() - 86_400_000)))
      .groupBy(emailEvent.status),
    db.execute(sql`SELECT COUNT(*)::text AS drifted FROM credit_wallet_drift`),
    measureLatency(() => db.execute(sql`SELECT 1`)),
  ]);

  return ok(c, {
    environment: config.INKLOOM_ENV,
    release: config.INKLOOM_RELEASE,
    database: { reachable: true, latencyMs: dbLatency },
    email: { last24h: emailStats, transport: config.EMAIL_TRANSPORT },
    credits: {
      // A non-zero value here is, by definition, a bug worth paging about.
      driftedWallets: Number((drift.rows[0] as { drifted?: string } | undefined)?.drifted ?? 0),
    },
    integrations: {
      turnstile: config.TURNSTILE_ENABLED,
      sentry: Boolean(config.SENTRY_DSN),
      googleOAuth: config.googleOAuthEnabled,
    },
  });
});

async function measureLatency(fn: () => Promise<unknown>): Promise<number> {
  const started = Date.now();
  await fn();
  return Date.now() - started;
}

/**
 * Security events carry a `targetEmail` for operators, but the IP hash and raw
 * user agent are not useful in the UI and are omitted from the wire format.
 */
function serialiseSecurityEvent(e: typeof securityEvent.$inferSelect) {
  return {
    id: e.id,
    type: e.type,
    severity: e.severity,
    userId: e.userId,
    targetEmail: e.targetEmail,
    createdAt: e.createdAt,
    metadata: e.metadata,
  };
}

// ===========================================================================
// Activity, performance and infrastructure
// ===========================================================================

/**
 * Everything the console's analytical pages read, in one endpoint.
 *
 * One request rather than four because these pages are opened together and
 * every figure comes from a pre-aggregated table — the whole response is a
 * handful of indexed reads over at most a few hundred rows. Splitting it would
 * multiply the round trips this console already makes without making any single
 * page faster.
 *
 * `days` is clamped rather than validated-and-rejected: an operator typing an
 * absurd range should get the largest sensible answer, not an error.
 */
adminRoutes.get("/insights", requirePermission("admin.overview.read"), async (c) => {
  const { db } = c.get("services");
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 1), 90);
  const since = new Date(Date.now() - days * 86_400_000);
  const sinceDay = since.toISOString().slice(0, 10);

  const [daily, hourly, byGroup, todayLive, providers] = await Promise.all([
    // The roll-up, oldest first so a chart can render it directly.
    db.execute<Record<string, string | null>>(sql`
      SELECT * FROM daily_metrics WHERE day >= ${sinceDay}::date ORDER BY day ASC
    `),

    /*
     * Traffic by hour of day, summed across the window.
     *
     * This is the "when are people actually using this" answer, and it has to
     * be summed across days rather than read from one — a single day's shape is
     * noise at early-access volume.
     */
    db.execute<{ hour: number; requests: string }>(sql`
      SELECT hour, SUM(requests)::text AS requests
        FROM request_metrics
       WHERE day >= ${sinceDay}::date
       GROUP BY hour ORDER BY hour
    `),

    // Volume, outcome and merged latency histogram per route group.
    db.execute<Record<string, unknown>>(sql`
      SELECT
        route_group,
        SUM(requests)::int          AS requests,
        SUM(status_2xx)::int        AS status_2xx,
        SUM(status_4xx)::int        AS status_4xx,
        SUM(status_429)::int        AS status_429,
        SUM(status_5xx)::int        AS status_5xx,
        SUM(duration_ms_total)::int AS duration_ms_total,
        MAX(duration_ms_max)::int   AS duration_ms_max,
        (
          SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
          FROM (
            SELECT key AS k, SUM(value::text::int)::int AS v
              FROM request_metrics rm2, jsonb_each(rm2.latency_buckets)
             WHERE rm2.route_group = rm.route_group AND rm2.day >= ${sinceDay}::date
             GROUP BY key
          ) merged
        ) AS latency_buckets,
        (
          SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
          FROM (
            SELECT key AS k, SUM(value::text::int)::int AS v
              FROM request_metrics rm3, jsonb_each(rm3.error_codes)
             WHERE rm3.route_group = rm.route_group AND rm3.day >= ${sinceDay}::date
             GROUP BY key
          ) merged
        ) AS error_codes
      FROM request_metrics rm
      WHERE day >= ${sinceDay}::date
      GROUP BY route_group
      ORDER BY requests DESC
    `),

    /*
     * Today, computed live rather than read from the roll-up.
     *
     * The roll-up only covers days that have ENDED, so without this the console
     * would show nothing at all for the current day and look broken every
     * morning. These are the same definitions the roll-up uses.
     */
    db.execute<Record<string, string>>(sql`
      SELECT
        (SELECT COUNT(*) FROM users WHERE created_at >= CURRENT_DATE)                       AS signups,
        (SELECT COUNT(DISTINCT user_id) FROM sessions WHERE last_active_at >= CURRENT_DATE) AS dau,
        (SELECT COUNT(*) FROM security_events
          WHERE type = 'login_succeeded' AND created_at >= CURRENT_DATE)                    AS logins,
        (SELECT COUNT(*) FROM email_events WHERE created_at >= CURRENT_DATE)                AS emails_sent,
        (SELECT COUNT(*) FROM email_events
          WHERE status IN ('failed','bounced') AND created_at >= CURRENT_DATE)              AS emails_failed,
        (SELECT COALESCE(SUM(requests),0) FROM request_metrics WHERE day = CURRENT_DATE)    AS requests,
        (SELECT COALESCE(SUM(status_5xx),0) FROM request_metrics WHERE day = CURRENT_DATE)  AS errors
    `),

    // Latest reading per provider metric. DISTINCT ON keeps one row each.
    db.execute<Record<string, string | null>>(sql`
      SELECT DISTINCT ON (provider, metric) provider, metric, value, unit, allowance, day, captured_at
        FROM provider_metrics
       ORDER BY provider, metric, day DESC
    `),
  ]);

  const live = todayLive.rows[0] ?? {};
  const n = (key: string) => Number(live[key] ?? 0);

  return ok(c, {
    windowDays: days,
    daily: daily.rows,
    hourly: hourly.rows.map((r) => ({ hour: Number(r.hour), requests: Number(r.requests) })),
    routeGroups: byGroup.rows,
    today: {
      signups: n("signups"),
      dau: n("dau"),
      logins: n("logins"),
      emailsSent: n("emails_sent"),
      emailsFailed: n("emails_failed"),
      requests: n("requests"),
      errors: n("errors"),
    },
    providers: providers.rows,
  });
});

// ===========================================================================
// Email deliverability
// ===========================================================================

/**
 * How mail is actually doing.
 *
 * The most important operational question this console answers, because mail is
 * the one failure that is INVISIBLE from the outside: a verification that never
 * arrives looks, to the person waiting, exactly like a slow one, and the signup
 * page has already told them it is on its way. Nothing else in the product can
 * fail this quietly.
 */
adminRoutes.get("/emails", requirePermission("admin.overview.read"), async (c) => {
  const { db } = c.get("services");
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 1), 90);
  const since = new Date(Date.now() - days * 86_400_000);

  const [byTemplate, daily, failures, totals] = await Promise.all([
    // One row per template with its outcome split, worst delivery rate first.
    db.execute<Record<string, string>>(sql`
      SELECT
        template,
        COUNT(*)::text                                                        AS total,
        COUNT(*) FILTER (WHERE status IN ('sent','delivered'))::text          AS delivered,
        COUNT(*) FILTER (WHERE status = 'queued')::text                       AS queued,
        COUNT(*) FILTER (WHERE status = 'bounced')::text                      AS bounced,
        COUNT(*) FILTER (WHERE status = 'complained')::text                   AS complained,
        COUNT(*) FILTER (WHERE status = 'failed')::text                       AS failed
      FROM email_events
      WHERE created_at >= ${since}
      GROUP BY template
      ORDER BY COUNT(*) FILTER (WHERE status IN ('failed','bounced')) DESC, COUNT(*) DESC
    `),

    db.execute<Record<string, string>>(sql`
      SELECT
        created_at::date::text                                       AS day,
        COUNT(*)::text                                               AS sent,
        COUNT(*) FILTER (WHERE status IN ('failed','bounced'))::text AS failed
      FROM email_events
      WHERE created_at >= ${since}
      GROUP BY 1 ORDER BY 1 ASC
    `),

    /*
     * Recent failures, with the provider's own reason.
     *
     * The recipient address IS included, unlike in the metrics tables — this is
     * the admin console, the caller has already passed the owner gate and 2FA,
     * and "which address bounced" is the entire point of the screen. Every view
     * of it is behind the same audited permission as the rest.
     */
    db.execute<Record<string, string | null>>(sql`
      SELECT id, template, to_email, status, error, created_at
        FROM email_events
       WHERE status IN ('failed','bounced','complained') AND created_at >= ${since}
       ORDER BY created_at DESC
       LIMIT 50
    `),

    db.execute<Record<string, string>>(sql`
      SELECT
        COUNT(*)::text                                                 AS total,
        COUNT(*) FILTER (WHERE status IN ('sent','delivered'))::text   AS delivered,
        COUNT(*) FILTER (WHERE status IN ('failed','bounced'))::text   AS failed,
        COUNT(*) FILTER (WHERE status = 'queued')::text                AS queued,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::text       AS today
      FROM email_events WHERE created_at >= ${since}
    `),
  ]);

  return ok(c, {
    windowDays: days,
    totals: totals.rows[0] ?? {},
    byTemplate: byTemplate.rows,
    daily: daily.rows,
    failures: failures.rows,
  });
});

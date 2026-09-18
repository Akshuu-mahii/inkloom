/**
 * Endpoints scoped to the signed-in user.
 *
 * Every handler derives the subject from `principal.userId` — never from a path
 * parameter, a query string or a body field. There is deliberately no
 * `/api/v1/users/:id` for ordinary users, so the classic IDOR (swap the id in
 * the URL) has no surface to attack.
 */
import { Hono } from "hono";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import {
  accessCodeRedemption,
  account as accountTable,
  creditLedger,
  dataExportRequest,
  newId,
  notification,
  notificationPreference,
  profile as profileTable,
  session as sessionTable,
  user as userTable,
  userConsent,
} from "@inkloom/db";
import { displayDeviceLabel, sessionCookieName } from "@inkloom/core/auth";
import { templates } from "@inkloom/email";
import type { Env } from "../context";
import { apiError, ok, paged } from "../lib/response";
import { body, query, validateBody, validateQuery } from "../middleware/validate";
import { passesOwnerGate, requireAuth } from "../middleware/auth";
import { isAdminRole } from "@inkloom/core/rbac";
import { anonymiseAccount } from "@inkloom/core/privacy";
import { verifyPassword } from "better-auth/crypto";
import { defer } from "../lib/defer";
import { rateLimit, bySubjectUser } from "../middleware/rate-limit";
import {
  deleteAccountSchema,
  notificationPreferencesSchema,
  paginationSchema,
  updateMeSchema,
} from "../schemas/index";

export const meRoutes = new Hono<Env>();

meRoutes.use("*", requireAuth);

// ---------------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------------
meRoutes.get("/", async (c) => {
  const principal = c.get("principal")!;
  const { db, credits, settings, config } = c.get("services");

  /*
   * One query for everything the dashboard displays.
   *
   * This endpoint is the layout loader, so it runs on EVERY navigation inside
   * the signed-in app. It used to cost six separate statements — profile,
   * notification preferences, wallet, redemption count, the user row, and the
   * linked accounts — on top of the three the authorization middleware already
   * spends. Nine statements to render a page header.
   *
   * Every one of those six is keyed on the same user id and none of them reads
   * another's result, so they are one query with joins. The count and the
   * provider list are scalar subqueries because they are aggregates, not rows.
   *
   * What is deliberately NOT folded in: the three authorization statements.
   * Those re-read the session and the user on every request so that a
   * revocation, a suspension, an emergency logout or a role removal takes effect
   * immediately, and they stay exactly as they were.
   *
   * `provider_id` and a boolean leave the server; the password hash is reduced
   * to `IS NOT NULL` inside the database and never travels.
   */
  const snapshot = await db.execute<{
    created_at: Date;
    early_access_joined_at: Date | null;
    display_name: string | null;
    company: string | null;
    timezone: string | null;
    product_updates_email: boolean | null;
    marketing_email: boolean | null;
    credits_email: boolean | null;
    wallet_balance: number | null;
    redemption_count: number;
    providers: string[] | null;
    has_password: boolean;
  }>(sql`
    SELECT
      u.created_at,
      u.early_access_joined_at,
      p.display_name,
      p.company,
      p.timezone,
      np.product_updates_email,
      np.marketing_email,
      np.credits_email,
      w.balance AS wallet_balance,
      (SELECT COUNT(*)::int FROM access_code_redemptions r WHERE r.user_id = u.id)
        AS redemption_count,
      (SELECT COALESCE(ARRAY_AGG(a.provider_id), '{}') FROM accounts a WHERE a.user_id = u.id)
        AS providers,
      EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id AND a.password IS NOT NULL)
        AS has_password
    FROM users u
    LEFT JOIN profiles p                  ON p.user_id  = u.id
    LEFT JOIN notification_preferences np ON np.user_id = u.id
    LEFT JOIN credit_wallets w            ON w.user_id  = u.id
    WHERE u.id = ${principal.userId}
  `);

  const row = snapshot.rows[0];
  if (!row) throw apiError("NOT_FOUND");

  /*
   * A missing wallet is created, not assumed to be zero.
   *
   * `getBalance` inserts one on first read, so the join above cannot replace it
   * outright — but it only has to run for an account that has never had a
   * wallet, which is a once-per-user event rather than a once-per-navigation
   * one. The common path stays at a single query.
   */
  const balance = row.wallet_balance ?? (await credits.getBalance(principal.userId)).balance;

  return ok(c, {
    // Note what is NOT here: no password hash, no session token, no internal
    // id, no raw IP. The serialisation is explicit rather than a row spread,
    // so a new sensitive column cannot leak by being added to the table.
    id: principal.userId,
    email: principal.email,
    name: principal.name,
    emailVerified: principal.emailVerified,
    role: principal.role,
    status: principal.status,
    twoFactorEnabled: principal.twoFactorEnabled,
    /*
     * Whether this account may open the admin console.
     *
     * Computed HERE, server-side, from the same owner gate the admin API
     * enforces — so the page gate and the API gate cannot drift apart and
     * disagree. The console's loader reads this one boolean rather than
     * re-deriving the rule in the browser, where a subtly different email
     * normalisation would either lock the owner out or, far worse, let someone
     * else in.
     *
     * Safe to return: it tells the caller only about themselves, and it is a
     * courtesy for rendering. The control is `requirePermission`, which runs
     * again on every admin request regardless of what this said.
     *
     * DELIBERATELY EXCLUDES 2FA, which is checked separately by the console.
     * Folding it in here collapsed two very different people into one generic
     * "Restricted" screen: a stranger who guessed the URL, and a legitimate
     * owner who simply has not enrolled yet. The second has already cleared the
     * owner and role gates — they have proved who they are — so telling them to
     * enrol reveals nothing they do not know and is the difference between a
     * wall and a dead end. Everyone who has NOT cleared those gates still gets
     * the identical restricted screen, so there is no oracle.
     */
    canAccessAdmin: isAdminRole(principal.role) && passesOwnerGate(principal, config.OWNER_EMAIL),
    hasPassword: row.has_password,
    providers: row.providers ?? [],
    createdAt: row.created_at,
    earlyAccess: {
      joined: Boolean(row.early_access_joined_at),
      joinedAt: row.early_access_joined_at,
    },
    profile: {
      displayName: row.display_name ?? principal.name,
      company: row.company,
      timezone: row.timezone,
    },
    credits: { balance },
    redemptions: row.redemption_count,
    notificationPreferences: {
      securityEmail: true,
      productUpdatesEmail: row.product_updates_email ?? true,
      marketingEmail: row.marketing_email ?? false,
      creditsEmail: row.credits_email ?? true,
    },
    platform: {
      // Feature flags are resolved server-side and sent as plain booleans. The
      // client never decides what is enabled; it only renders what it is told.
      generationEnabled: await settings.isEnabled("generation_enabled"),
      paymentsEnabled: await settings.isEnabled("payments_enabled"),
      redemptionEnabled: await settings.isEnabled("code_redemption_enabled"),
    },
  });
});

// ---------------------------------------------------------------------------
// PATCH /me
// ---------------------------------------------------------------------------
meRoutes.patch("/", validateBody(updateMeSchema), async (c) => {
  const principal = c.get("principal")!;
  const { db, audit } = c.get("services");
  const input = body<{ name?: string; company?: string; timezone?: string }>(c);

  await db.transaction(async (tx) => {
    if (input.name) {
      await tx
        .update(userTable)
        .set({ name: input.name, updatedAt: new Date() })
        .where(eq(userTable.id, principal.userId));
    }
    await tx
      .insert(profileTable)
      .values({
        id: newId("prf"),
        userId: principal.userId,
        displayName: input.name ?? principal.name,
        company: input.company ?? null,
        timezone: input.timezone ?? null,
      })
      .onConflictDoUpdate({
        target: profileTable.userId,
        set: {
          ...(input.name ? { displayName: input.name } : {}),
          ...(input.company !== undefined ? { company: input.company } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          updatedAt: new Date(),
        },
      });

    await audit.record(tx, {
      action: "user.profile.update",
      actorType: "user",
      actorId: principal.userId,
      targetType: "user",
      targetId: principal.userId,
      metadata: { fields: Object.keys(input) },
      requestId: c.get("requestId"),
      ipHash: c.get("ipHash"),
    });
  });

  return ok(c, { success: true });
});

// ---------------------------------------------------------------------------
// GET /me/sessions
// ---------------------------------------------------------------------------
meRoutes.get("/sessions", async (c) => {
  const principal = c.get("principal")!;
  const { db } = c.get("services");

  const rows = await db
    .select({
      id: sessionTable.id,
      createdAt: sessionTable.createdAt,
      lastActiveAt: sessionTable.lastActiveAt,
      expiresAt: sessionTable.expiresAt,
      userAgent: sessionTable.userAgent,
    })
    .from(sessionTable)
    .where(and(eq(sessionTable.userId, principal.userId), isNull(sessionTable.revokedAt)))
    .orderBy(desc(sessionTable.lastActiveAt))
    .limit(50);

  return ok(c, {
    sessions: rows.map((row) => ({
      id: row.id,
      // A coarse device label only. No IP address — not even the hashed one —
      // and no fingerprint: enough for a user to recognise their own devices,
      // not enough to be a tracking surface if the response ever leaked.
      /*
       * The stored value is ALREADY a device label.
       *
       * `deviceLabel()` is applied once, in the session-create hook, so the full
       * User-Agent never reaches storage. Applying it again here re-parsed its
       * own output: "Chrome on macOS" contains no "mac os" (no space) and no
       * "macintosh", so it came back as "Chrome on Unknown OS" — which is
       * exactly what the sessions page showed.
       */
      device: displayDeviceLabel(row.userAgent),
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
      expiresAt: row.expiresAt,
      current: row.id === principal.sessionId,
    })),
  });
});

// ---------------------------------------------------------------------------
// DELETE /me/sessions/:id
// ---------------------------------------------------------------------------
meRoutes.delete("/sessions/:id", async (c) => {
  const principal = c.get("principal")!;
  const { db, audit } = c.get("services");
  const sessionId = c.req.param("id");

  // Ownership check: scoped to this user's sessions, so passing someone else's
  // session id finds nothing. 404, not 403 — a 403 would confirm it exists.
  const target = await db.query.session.findFirst({
    where: and(eq(sessionTable.id, sessionId), eq(sessionTable.userId, principal.userId)),
  });
  if (!target) throw apiError("NOT_FOUND");

  await db
    .update(sessionTable)
    .set({ revokedAt: new Date(), revokedReason: "user_revoked" })
    .where(eq(sessionTable.id, sessionId));

  await audit.recordStandalone({
    action: "user.session.revoke",
    actorType: "user",
    actorId: principal.userId,
    targetType: "session",
    targetId: sessionId,
    requestId: c.get("requestId"),
    ipHash: c.get("ipHash"),
  });
  await audit.security({
    type: "session_revoked",
    userId: principal.userId,
    ipHash: c.get("ipHash"),
    requestId: c.get("requestId"),
    metadata: { self: sessionId === principal.sessionId },
  });

  return ok(c, { success: true, wasCurrent: sessionId === principal.sessionId });
});

// ---------------------------------------------------------------------------
// GET /me/notifications
// ---------------------------------------------------------------------------
meRoutes.get("/notifications", validateQuery(paginationSchema), async (c) => {
  const principal = c.get("principal")!;
  const { db } = c.get("services");
  const { limit, cursor } = query<{ limit: number; cursor?: string }>(c);

  const rows = await db.query.notification.findMany({
    where: cursor
      ? and(eq(notification.userId, principal.userId), lt(notification.createdAt, new Date(cursor)))
      : eq(notification.userId, principal.userId),
    orderBy: [desc(notification.createdAt)],
    limit: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return ok(
    c,
    paged(
      page.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        actionPath: n.actionPath,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      hasMore ? (page.at(-1)?.createdAt.toISOString() ?? null) : null,
    ),
  );
});

// ---------------------------------------------------------------------------
// PATCH /me/notification-preferences
// ---------------------------------------------------------------------------
meRoutes.patch(
  "/notification-preferences",
  validateBody(notificationPreferencesSchema),
  async (c) => {
    const principal = c.get("principal")!;
    const { db } = c.get("services");
    const input = body<Record<string, boolean | undefined>>(c);

    await db
      .insert(notificationPreference)
      .values({ id: newId("npf"), userId: principal.userId, ...input })
      .onConflictDoUpdate({
        target: notificationPreference.userId,
        // `securityEmail` is absent from the schema and so can never appear
        // here; a database CHECK pins it true regardless.
        set: { ...input, updatedAt: new Date() },
      });

    if (input.marketingEmail !== undefined) {
      await db.insert(userConsent).values({
        id: newId("cns"),
        userId: principal.userId,
        type: "marketing_email",
        granted: input.marketingEmail,
        source: "settings",
        ipHash: c.get("ipHash"),
      });
    }

    return ok(c, { success: true });
  },
);

// ---------------------------------------------------------------------------
// POST /me/export
// ---------------------------------------------------------------------------
meRoutes.post(
  "/export",
  rateLimit({ bucket: "data.export.user", subject: bySubjectUser }),
  async (c) => {
    const principal = c.get("principal")!;
    const { db, mailer, config, audit } = c.get("services");

    const [account, prof, ledger, redemptions, consents, sessions] = await Promise.all([
      db.query.user.findFirst({ where: eq(userTable.id, principal.userId) }),
      db.query.profile.findFirst({ where: eq(profileTable.userId, principal.userId) }),
      db.query.creditLedger.findMany({
        where: eq(creditLedger.userId, principal.userId),
        orderBy: [desc(creditLedger.createdAt)],
        limit: 1000,
      }),
      db.query.accessCodeRedemption.findMany({
        where: eq(accessCodeRedemption.userId, principal.userId),
      }),
      db.query.userConsent.findMany({ where: eq(userConsent.userId, principal.userId) }),
      db.query.session.findMany({ where: eq(sessionTable.userId, principal.userId), limit: 100 }),
    ]);

    // Everything the user is entitled to, and nothing they are not: no internal
    // admin notes, no other users' data, no password hash, no session tokens.
    const payload = {
      exportedAt: new Date().toISOString(),
      account: {
        id: account?.id,
        email: account?.email,
        name: account?.name,
        emailVerified: account?.emailVerified,
        status: account?.status,
        createdAt: account?.createdAt,
        earlyAccessJoinedAt: account?.earlyAccessJoinedAt,
      },
      profile: prof
        ? { displayName: prof.displayName, company: prof.company, timezone: prof.timezone }
        : null,
      credits: {
        ledger: ledger.map((e) => ({
          amount: e.amount,
          type: e.type,
          balanceAfter: e.balanceAfter,
          reason: e.reason,
          createdAt: e.createdAt,
        })),
      },
      accessCodeRedemptions: redemptions.map((r) => ({
        creditsGranted: r.creditsGranted,
        redeemedAt: r.redeemedAt,
      })),
      consents: consents.map((x) => ({
        type: x.type,
        granted: x.granted,
        documentVersion: x.documentVersion,
        createdAt: x.createdAt,
      })),
      sessions: sessions.map((s) => ({
        // Already a label; see the note above.
        device: displayDeviceLabel(s.userAgent),
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        // Session tokens and IP hashes are deliberately excluded.
      })),
    };

    const exportId = newId("exp");
    await db.insert(dataExportRequest).values({
      id: exportId,
      userId: principal.userId,
      status: "ready",
      payload,
      completedAt: new Date(),
      // Self-destructs: the row stays for audit, the payload is nulled by the
      // retention sweep.
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    });

    await mailer.send({
      to: principal.email,
      template: "data_export_ready",
      userId: principal.userId,
      force: true,
      rendered: templates.dataExportReady(
        { appUrl: config.APP_URL, supportEmail: config.SUPPORT_EMAIL },
        { name: principal.name, expiresInHours: 24 },
      ),
    });

    await audit.recordStandalone({
      action: "user.data.export",
      actorType: "user",
      actorId: principal.userId,
      targetType: "user",
      targetId: principal.userId,
      requestId: c.get("requestId"),
      ipHash: c.get("ipHash"),
    });
    await audit.security({
      type: "data_export_requested",
      userId: principal.userId,
      ipHash: c.get("ipHash"),
      requestId: c.get("requestId"),
    });

    return ok(c, { exportId, status: "ready", data: payload });
  },
);

// ---------------------------------------------------------------------------
// DELETE /me  — erase this account
// ---------------------------------------------------------------------------
/**
 * Self-service erasure.
 *
 * The account becomes a tombstone rather than a deleted row: the append-only
 * audit trail and credit ledger reference this user id and cannot be rewritten,
 * so the id survives while everything identifying about it is destroyed. See
 * `@inkloom/core/privacy` for what is erased and what deliberately is not.
 *
 * Two guards, for two different failure modes:
 *
 *   - The PASSWORD, verified here rather than trusted from the session, so a
 *     borrowed laptop with a live session cannot destroy an account.
 *   - The LAST OWNER check, so nobody can lock the whole organisation out of
 *     its own admin console by erasing the only account that can reach it.
 *     Bootstrapping a new super-admin requires an existing verified account,
 *     so this is not recoverable from inside the product.
 */
meRoutes.delete("/", validateBody(deleteAccountSchema), async (c) => {
  const principal = c.get("principal")!;
  const { db, audit, logger } = c.get("services");
  const input = body<{ currentPassword: string }>(c);

  const credential = await db.query.account.findFirst({
    where: and(
      eq(accountTable.userId, principal.userId),
      eq(accountTable.providerId, "credential"),
    ),
  });

  /*
   * An account with no password — signed up with a social provider — cannot
   * prove intent this way. Refusing is better than erasing on a session alone;
   * they set a password first, which the dashboard already supports.
   */
  if (!credential?.password) {
    throw apiError("REAUTH_REQUIRED", {
      details: { reason: "Set a password before erasing your account." },
    });
  }

  const proven = await verifyPassword({
    hash: credential.password,
    password: input.currentPassword,
  }).catch(() => false);

  if (!proven) {
    await defer(
      c,
      audit.security({
        type: "login_failed",
        severity: "warning",
        userId: principal.userId,
        ipHash: c.get("ipHash"),
        requestId: c.get("requestId"),
        metadata: { flow: "account_erasure_wrong_password" },
      }),
      "security_event",
    );
    throw apiError("INVALID_CREDENTIALS", {
      details: { currentPassword: "That password doesn't match your current one." },
    });
  }

  if (isAdminRole(principal.role as never)) {
    const others = await db.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n FROM users
       WHERE role = 'super_admin' AND status = 'active' AND id <> ${principal.userId}
    `);
    if (principal.role === "super_admin" && Number(others.rows[0]?.n ?? 0) === 0) {
      throw apiError("FORBIDDEN", {
        details: {
          reason: "You are the only owner. Promote another owner before erasing this account.",
        },
      });
    }
  }

  const result = await anonymiseAccount(db, audit, logger, {
    userId: principal.userId,
    actorType: "user",
    actorId: principal.userId,
    reason: "Self-service account erasure",
    requestId: c.get("requestId"),
    ipHash: c.get("ipHash"),
  });

  /*
   * Clear the cookie on the way out.
   *
   * The session row is already gone, so the cookie is inert either way — but
   * leaving it set means the browser keeps presenting a credential for an
   * account that no longer exists, and the next page load looks like a bug
   * rather than a completed erasure.
   */
  const response = ok(c, {
    erased: true,
    erasedAt: result.anonymizedAt,
    message: "Your account has been erased. This cannot be undone.",
  });
  response.headers.append(
    "set-cookie",
    `${sessionCookieName(c.get("services").config.APP_URL.startsWith("https://"))}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${
      c.get("services").config.APP_URL.startsWith("https://") ? "; Secure" : ""
    }`,
  );
  return response;
});

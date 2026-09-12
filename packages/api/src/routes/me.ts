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
import { deviceLabel } from "@inkloom/core/auth";
import { templates } from "@inkloom/email";
import type { Env } from "../context";
import { apiError, ok, paged } from "../lib/response";
import { body, query, validateBody, validateQuery } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { rateLimit, bySubjectUser } from "../middleware/rate-limit";
import {
  changeEmailSchema,
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
  const { db, credits, settings } = c.get("services");

  const [profile, prefs, wallet, redemptionCount] = await Promise.all([
    db.query.profile.findFirst({ where: eq(profileTable.userId, principal.userId) }),
    db.query.notificationPreference.findFirst({
      where: eq(notificationPreference.userId, principal.userId),
    }),
    credits.getBalance(principal.userId),
    db.$count(accessCodeRedemption, eq(accessCodeRedemption.userId, principal.userId)),
  ]);

  const account = await db.query.user.findFirst({ where: eq(userTable.id, principal.userId) });

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
    createdAt: account?.createdAt ?? null,
    earlyAccess: {
      joined: Boolean(account?.earlyAccessJoinedAt),
      joinedAt: account?.earlyAccessJoinedAt ?? null,
    },
    profile: {
      displayName: profile?.displayName ?? principal.name,
      company: profile?.company ?? null,
      timezone: profile?.timezone ?? null,
    },
    credits: { balance: wallet.balance },
    redemptions: redemptionCount,
    notificationPreferences: {
      securityEmail: true,
      productUpdatesEmail: prefs?.productUpdatesEmail ?? true,
      marketingEmail: prefs?.marketingEmail ?? false,
      creditsEmail: prefs?.creditsEmail ?? true,
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
// POST /me/change-email
// ---------------------------------------------------------------------------
meRoutes.post("/change-email", validateBody(changeEmailSchema), async (c) => {
  const principal = c.get("principal")!;
  const { auth, mailer, config, audit } = c.get("services");
  const input = body<{ newEmail: string; currentPassword: string }>(c);

  // Re-authenticate before a change this consequential. A hijacked but idle
  // session must not be able to walk the account away.
  const reauth = await auth.api
    .signInEmail({
      body: { email: principal.email, password: input.currentPassword },
      headers: c.req.raw.headers,
      asResponse: true,
    })
    .catch(() => null);

  if (!reauth?.ok) throw apiError("INVALID_CREDENTIALS");

  await auth.api
    .changeEmail({
      body: { newEmail: input.newEmail, callbackURL: "/app/profile" },
      headers: c.req.raw.headers,
    })
    .catch(() => {
      // Do not disclose whether the target address is already registered.
      return null;
    });

  // Notify the OLD address, so the legitimate owner learns about it even if an
  // attacker initiated the change.
  await mailer.send({
    to: principal.email,
    template: "email_changed",
    userId: principal.userId,
    force: true,
    rendered: templates.emailChanged(
      { appUrl: config.APP_URL, supportEmail: config.SUPPORT_EMAIL },
      { name: principal.name, newEmail: input.newEmail, when: new Date().toUTCString() },
    ),
  });

  await audit.security({
    type: "email_change_requested",
    severity: "warning",
    userId: principal.userId,
    ipHash: c.get("ipHash"),
    requestId: c.get("requestId"),
  });

  return ok(c, {
    success: true,
    message: "Check your current inbox to confirm the change.",
  });
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
      device: deviceLabel(row.userAgent),
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
  rateLimit({ bucket: "support.submit.user", subject: bySubjectUser }),
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
        device: deviceLabel(s.userAgent),
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
// DELETE /me
// ---------------------------------------------------------------------------
meRoutes.delete("/", validateBody(deleteAccountSchema), async (c) => {
  const principal = c.get("principal")!;
  const { auth, db, mailer, config, audit, settings } = c.get("services");
  const input = body<{ currentPassword: string; confirmation: string }>(c);

  /*
   * Checked BEFORE anything else, including the password.
   *
   * The dashboard hides the control when this flag is off, but that is
   * presentation. This is the control: with the flag off the endpoint refuses
   * whoever asks, however they ask.
   */
  if (!(await settings.isEnabled("account_deletion_enabled"))) {
    throw apiError("FEATURE_DISABLED", {
      details: {
        reason: "Account deletion is not self-service. Contact support and we will do it for you.",
      },
    });
  }

  // 1. Recent authentication, proven right now.
  const reauth = await auth.api
    .signInEmail({
      body: { email: principal.email, password: input.currentPassword },
      headers: c.req.raw.headers,
      asResponse: true,
    })
    .catch(() => null);
  if (!reauth?.ok) throw apiError("INVALID_CREDENTIALS");

  const originalEmail = principal.email;
  const originalName = principal.name;

  await db.transaction(async (tx) => {
    // 3. Revoke every session.
    await tx
      .update(sessionTable)
      .set({ revokedAt: new Date(), revokedReason: "account_deleted" })
      .where(eq(sessionTable.userId, principal.userId));

    // 4. Cancel pending email tokens. Better Auth keys them by the address, so
    //    anonymising the address below already orphans them; this removes them
    //    outright so a stale reset link cannot be redeemed.
    await tx.execute(sql`
      DELETE FROM verification_tokens
      WHERE identifier = ${originalEmail}
         OR identifier = ${`reset-password:${principal.userId}`}
    `);

    // 5/6. Anonymise rather than delete. The accounting record — wallet, ledger,
    //      redemptions — is preserved and required, but is no longer linked to a
    //      person: the email, name and profile are replaced with tombstones, and
    //      the FK is `restrict` so the rows physically cannot be dropped.
    const tombstone = `deleted-${principal.userId}@deleted.inkloom.invalid`;
    await tx
      .update(userTable)
      .set({
        // `normalized_email` is a GENERATED column derived from `email`, so it
        // follows this change automatically and must not be assigned.
        email: tombstone,
        name: "Deleted account",
        image: null,
        status: "deleted",
        emailVerified: false,
        anonymizedAt: new Date(),
        deletionRequestedAt: new Date(),
        lastLoginIpHash: null,
        signupUtm: null,
        banned: true,
        banReason: "account_deleted",
      })
      .where(eq(userTable.id, principal.userId));

    await tx.delete(profileTable).where(eq(profileTable.userId, principal.userId));

    // 7. Audit event, inside the transaction so deletion cannot commit unaudited.
    await audit.record(tx, {
      action: "user.account.delete",
      actorType: "user",
      actorId: principal.userId,
      targetType: "user",
      targetId: principal.userId,
      reason: "User-requested deletion",
      metadata: { anonymized: true, ledgerPreserved: true },
      requestId: c.get("requestId"),
      ipHash: c.get("ipHash"),
    });
  });

  // 8. Confirmation, to the address as it was before anonymisation.
  await mailer.send({
    to: originalEmail,
    template: "account_deleted",
    force: true,
    rendered: templates.accountDeleted(
      { appUrl: config.APP_URL, supportEmail: config.SUPPORT_EMAIL },
      { name: originalName },
    ),
  });

  await audit.security({
    type: "account_deleted",
    severity: "warning",
    userId: principal.userId,
    ipHash: c.get("ipHash"),
    requestId: c.get("requestId"),
  });

  const response = ok(c, { success: true });
  // Clear the session cookie on the way out.
  const signOut = await auth.api
    .signOut({ headers: c.req.raw.headers, asResponse: true })
    .catch(() => null);
  for (const cookie of signOut?.headers.getSetCookie?.() ?? []) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
});

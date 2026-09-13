/**
 * Authentication and authorization middleware.
 *
 * Every fact used to make an access decision — role, status, verification,
 * 2FA enrolment — is read from the DATABASE inside these functions, on every
 * request. Nothing is trusted from a header, a body field, a query parameter,
 * or a client-held claim. That is the whole point: hiding a button is UX,
 * `requirePermission` is the control.
 */
import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { session as sessionTable, user as userTable } from "@inkloom/db";
import {
  hasPermission,
  requiresReason,
  requiresReauth,
  toRole,
  type Permission,
} from "@inkloom/core/rbac";
import { isRecentlyAuthenticated, validateSession } from "@inkloom/core/auth";
import { apiError, errorResponse } from "../lib/response";
import type { Env, Principal } from "../context";

/**
 * Resolve the current principal, if any.
 *
 * Non-blocking: it populates `principal` when a valid session exists and does
 * nothing otherwise, so a route can be optionally-authenticated.
 */
export const loadPrincipal: MiddlewareHandler<Env> = async (c, next) => {
  const { auth, db, settings, logger } = c.get("services");

  const authSession = await auth.api
    .getSession({ headers: c.req.raw.headers })
    .catch((error: unknown) => {
      logger.warn("session_lookup_failed", { error });
      return null;
    });

  if (!authSession?.user?.id) return next();

  // Re-read the user and session together. Better Auth's snapshot may predate
  // a suspension or a role change made seconds ago.
  const row = await db
    .select({
      userId: userTable.id,
      email: userTable.email,
      normalizedEmail: userTable.normalizedEmail,
      name: userTable.name,
      emailVerified: userTable.emailVerified,
      role: userTable.role,
      status: userTable.status,
      twoFactorEnabled: userTable.twoFactorEnabled,
      sessionId: sessionTable.id,
      sessionCreatedAt: sessionTable.createdAt,
      sessionUpdatedAt: sessionTable.updatedAt,
      lastActiveAt: sessionTable.lastActiveAt,
      absoluteExpiresAt: sessionTable.absoluteExpiresAt,
      revokedAt: sessionTable.revokedAt,
    })
    .from(sessionTable)
    .innerJoin(userTable, eq(userTable.id, sessionTable.userId))
    .where(eq(sessionTable.id, authSession.session.id))
    .limit(1);

  const found = row[0];
  if (!found) return next();

  const role = toRole(found.role);
  const policy = await settings.get("session_policy");
  const epochs = await settings.get("session_epoch");
  const epoch = new Date(
    role === "user"
      ? epochs.users
      : Date.parse(epochs.admins) > Date.parse(epochs.users)
        ? epochs.admins
        : epochs.users,
  );

  const verdict = validateSession(
    {
      role,
      createdAt: found.sessionCreatedAt,
      lastActiveAt: found.lastActiveAt,
      absoluteExpiresAt: found.absoluteExpiresAt,
      revokedAt: found.revokedAt,
      epoch,
      userStatus: found.status,
    },
    policy,
  );

  if (!verdict.valid) {
    // The session exists but policy says it is over. Revoke it so the next
    // request is cheap, and leave the principal unset.
    await db
      .update(sessionTable)
      .set({ revokedAt: new Date(), revokedReason: verdict.reason })
      .where(eq(sessionTable.id, found.sessionId));

    c.get("logger").info("session_rejected", {
      reason: verdict.reason,
      userId: found.userId,
    });
    return next();
  }

  // Touch last activity so idle expiry tracks real use. Deliberately not
  // awaited on the hot path beyond the write itself.
  await db
    .update(sessionTable)
    .set({ lastActiveAt: new Date() })
    .where(eq(sessionTable.id, found.sessionId));

  const principal: Principal = {
    userId: found.userId,
    email: found.email,
    // Generated column; typed nullable by Drizzle even though Postgres always
    // populates it. Falling back keeps the principal's type honest.
    normalizedEmail: found.normalizedEmail ?? found.email.toLowerCase(),
    name: found.name,
    emailVerified: found.emailVerified,
    role,
    status: found.status,
    twoFactorEnabled: found.twoFactorEnabled,
    sessionId: found.sessionId,
    sessionCreatedAt: found.sessionCreatedAt,
    // Better Auth refreshes `updatedAt` when credentials are re-presented,
    // which is what "recent authentication" means here.
    lastAuthenticatedAt: found.sessionUpdatedAt,
  };

  c.set("principal", principal);
  c.set("logger", c.get("logger").child({ userId: principal.userId }));
  return next();
};

/** Require any authenticated, active user. */
export const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  const principal = c.get("principal");
  if (!principal) return errorResponse(c, apiError("UNAUTHENTICATED"));
  if (principal.status !== "active") return errorResponse(c, apiError("ACCOUNT_SUSPENDED"));
  return next();
};

/** Require a verified email on top of authentication. */
export const requireVerified: MiddlewareHandler<Env> = async (c, next) => {
  const principal = c.get("principal");
  if (!principal) return errorResponse(c, apiError("UNAUTHENTICATED"));
  if (!principal.emailVerified) return errorResponse(c, apiError("EMAIL_NOT_VERIFIED"));
  return next();
};

/**
 * The owner gate: a second, independent authority on staff access.
 *
 * `OWNER_EMAIL` lives in the deployment's secrets; the role lives in a database
 * column. Requiring both to agree means neither alone is sufficient — an
 * attacker who can write to `users.role` still does not hold the deployment
 * secret, and an attacker holding the secret still needs a real session for an
 * account that carries the role.
 *
 * Compared on the NORMALIZED address, because `Owner@Example.com` and
 * `owner@example.com` are the same mailbox and a case difference here would
 * lock the real owner out of their own console.
 *
 * Unset means "role check only". That is deliberate: staging environments
 * legitimately have several staff accounts, and forcing a single owner there
 * would push people towards sharing one login, which is worse than the thing
 * this defends against.
 */
export function passesOwnerGate(principal: Principal, ownerEmail: string | undefined): boolean {
  if (!ownerEmail) return true;
  return principal.normalizedEmail === ownerEmail.trim().toLowerCase();
}

/**
 * Require a specific permission.
 *
 * Also enforces the cross-cutting rules the brief attaches to high-impact
 * actions: the owner gate, mandatory 2FA for anyone holding an admin role, and
 * a recent authentication for permissions that move money or privilege.
 */
export function requirePermission(permission: Permission): MiddlewareHandler<Env> {
  return async (c, next) => {
    const principal = c.get("principal");
    const { audit, config } = c.get("services");

    if (!principal) return errorResponse(c, apiError("UNAUTHENTICATED"));

    /*
     * Owner gate first, and it answers FORBIDDEN without saying why.
     *
     * Someone who holds a staff role but is not the owner is the most
     * interesting case in this file: either a legitimate change nobody
     * completed, or a privilege escalation in progress. It is recorded at
     * `warning` either way, and the response tells them nothing they could use
     * to work out which of the several gates stopped them.
     */
    if (!passesOwnerGate(principal, config.OWNER_EMAIL)) {
      await audit.security({
        type: "unauthorized_admin_access",
        severity: "warning",
        userId: principal.userId,
        ipHash: c.get("ipHash"),
        requestId: c.get("requestId"),
        metadata: {
          permission,
          role: principal.role,
          reason: "owner_gate",
          path: new URL(c.req.url).pathname,
        },
      });
      return errorResponse(c, apiError("FORBIDDEN"));
    }

    if (!hasPermission(principal.role, permission)) {
      // Every refused admin access is a security event: a user probing
      // /api/v1/admin/* is exactly what an operator wants to see.
      await audit.security({
        type: "unauthorized_admin_access",
        severity: "warning",
        userId: principal.userId,
        ipHash: c.get("ipHash"),
        requestId: c.get("requestId"),
        metadata: {
          permission,
          role: principal.role,
          path: new URL(c.req.url).pathname,
        },
      });
      // A plain 403 — not a 404 — because the caller IS authenticated and
      // telling them they lack permission leaks nothing they don't know.
      return errorResponse(c, apiError("FORBIDDEN"));
    }

    // Mandatory 2FA for admins. Checked here rather than at login so that an
    // account PROMOTED to an admin role is also covered immediately.
    if (principal.role !== "user" && !principal.twoFactorEnabled) {
      return errorResponse(
        c,
        apiError("TWO_FACTOR_REQUIRED", {
          details: {
            reason: "Two-factor authentication is required for staff accounts.",
            enrolPath: "/app/security",
          },
        }),
      );
    }

    if (!principal.emailVerified) {
      return errorResponse(c, apiError("EMAIL_NOT_VERIFIED"));
    }

    if (requiresReauth(permission) && !isRecentlyAuthenticated(principal.lastAuthenticatedAt)) {
      return errorResponse(
        c,
        apiError("REAUTH_REQUIRED", {
          details: { reason: "Confirm your password to perform this action." },
        }),
      );
    }

    return next();
  };
}

/**
 * Ownership check for user-scoped resources.
 *
 * The IDOR control. A resource is only reachable when its `userId` matches the
 * caller, unless the caller holds an explicit read permission for the admin
 * view. Returns 404 rather than 403 for cross-user access so an attacker
 * cannot use the response to confirm that another user's resource exists.
 */
export function assertOwnership(
  resourceUserId: string | null | undefined,
  principal: Principal,
): void {
  if (!resourceUserId || resourceUserId !== principal.userId) {
    throw apiError("NOT_FOUND");
  }
}

/** Validate that a reason was supplied where policy demands one. */
export function assertReason(permission: Permission, reason: string | undefined | null): string {
  if (!requiresReason(permission)) return reason?.trim() ?? "";
  const trimmed = reason?.trim() ?? "";
  if (trimmed.length < 4) {
    throw apiError("REASON_REQUIRED", {
      details: { reason: "Give a short reason — it is recorded in the audit log." },
    });
  }
  return trimmed;
}

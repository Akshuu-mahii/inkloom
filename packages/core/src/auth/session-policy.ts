/**
 * Session lifetime policy.
 *
 * Better Auth manages the session token and its cryptography; Inkloom layers
 * two extra rules on top that the library does not express directly:
 *
 *   1. An ABSOLUTE cutoff independent of activity. Better Auth's `expiresIn`
 *      slides forward as the user stays active, which is right for idle
 *      timeout but means a session could live indefinitely. `absoluteExpiresAt`
 *      is stamped once at creation and never extended.
 *
 *   2. A much shorter clock for admins. An admin session that has been idle
 *      for 30 minutes is dead, and no admin session outlives 12 hours,
 *      because an admin session is worth far more to an attacker.
 *
 *   3. A session EPOCH per audience. Raising it invalidates every session
 *      created before that instant — the mechanism behind "log out all users"
 *      and "log out all admins except me".
 */
import type { SessionPolicy } from "../settings/registry";
import { isAdminRole, type Role } from "../rbac/permissions";

export interface SessionValidationInput {
  role: Role;
  createdAt: Date;
  lastActiveAt: Date;
  absoluteExpiresAt: Date | null;
  revokedAt: Date | null;
  /** Sessions created before this are rejected. */
  epoch: Date;
  userStatus: string;
  now?: Date;
}

export type SessionVerdict =
  | { valid: true }
  | {
      valid: false;
      reason: "revoked" | "idle_expired" | "absolute_expired" | "epoch" | "suspended";
    };

export function idleLimitSeconds(role: Role, policy: SessionPolicy): number {
  return isAdminRole(role) ? policy.adminIdleSeconds : policy.userIdleSeconds;
}

export function absoluteLimitSeconds(role: Role, policy: SessionPolicy): number {
  return isAdminRole(role) ? policy.adminAbsoluteSeconds : policy.userAbsoluteSeconds;
}

/** Absolute cutoff to stamp on a newly created session. */
export function absoluteExpiryFor(
  role: Role,
  policy: SessionPolicy,
  from: Date = new Date(),
): Date {
  return new Date(from.getTime() + absoluteLimitSeconds(role, policy) * 1000);
}

/**
 * The single place a session's validity is decided. Called on every
 * authenticated request, before any handler runs.
 */
export function validateSession(
  input: SessionValidationInput,
  policy: SessionPolicy,
): SessionVerdict {
  const now = input.now ?? new Date();

  if (input.revokedAt) return { valid: false, reason: "revoked" };

  // A suspended user's sessions die immediately, without waiting for a sweep.
  if (input.userStatus !== "active") return { valid: false, reason: "suspended" };

  if (input.createdAt.getTime() < input.epoch.getTime()) {
    return { valid: false, reason: "epoch" };
  }

  const idleMs = idleLimitSeconds(input.role, policy) * 1000;
  if (now.getTime() - input.lastActiveAt.getTime() > idleMs) {
    return { valid: false, reason: "idle_expired" };
  }

  const absolute =
    input.absoluteExpiresAt ??
    new Date(input.createdAt.getTime() + absoluteLimitSeconds(input.role, policy) * 1000);
  if (now.getTime() >= absolute.getTime()) {
    return { valid: false, reason: "absolute_expired" };
  }

  return { valid: true };
}

/**
 * Whether an action needing "recent authentication" may proceed.
 *
 * Distinct from session validity: a session can be perfectly valid and still be
 * too stale to, say, delete an account or adjust credits.
 */
export const FRESHNESS_WINDOW_SECONDS = 15 * 60;

export function isRecentlyAuthenticated(
  lastAuthenticatedAt: Date | null,
  now: Date = new Date(),
  windowSeconds: number = FRESHNESS_WINDOW_SECONDS,
): boolean {
  if (!lastAuthenticatedAt) return false;
  return now.getTime() - lastAuthenticatedAt.getTime() <= windowSeconds * 1000;
}

/**
 * Coarse device label derived from a User-Agent.
 *
 * The sessions page must help a user recognise their own devices without
 * storing a fingerprint. "Chrome on macOS" is enough to spot an intruder;
 * the full UA string is not retained.
 */
export function deviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const ua = userAgent.toLowerCase();

  const os = ua.includes("windows")
    ? "Windows"
    : ua.includes("android")
      ? "Android"
      : ua.includes("iphone") || ua.includes("ipad")
        ? "iOS"
        : ua.includes("mac os") || ua.includes("macintosh")
          ? "macOS"
          : ua.includes("linux")
            ? "Linux"
            : "Unknown OS";

  // Order matters: Edge and Brave both claim Chrome, Chrome claims Safari.
  const browser = ua.includes("edg/")
    ? "Edge"
    : ua.includes("opr/") || ua.includes("opera")
      ? "Opera"
      : ua.includes("firefox")
        ? "Firefox"
        : ua.includes("chrome")
          ? "Chrome"
          : ua.includes("safari")
            ? "Safari"
            : "Unknown browser";

  /*
   * When neither half is known, say so once.
   *
   * "Unknown browser on Unknown OS" is technically accurate and reads like a
   * fault. It happens when a request genuinely carries no User-Agent — a
   * server-to-server call, or a client that strips it — and "Unknown device"
   * says the same thing without looking broken.
   */
  if (browser === "Unknown browser" && os === "Unknown OS") return "Unknown device";

  return `${browser} on ${os}`;
}

/**
 * Tidy a label that was stored before `deviceLabel` produced "Unknown device".
 *
 * Existing rows keep whatever string was written at the time, and they live for
 * up to 30 days. This is display-only: it never rewrites stored data.
 */
export function displayDeviceLabel(stored: string | null | undefined): string {
  if (!stored) return "Unknown device";
  return stored === "Unknown browser on Unknown OS" ? "Unknown device" : stored;
}

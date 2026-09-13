/**
 * Rate-limit policy definitions.
 *
 * Two principles shape these numbers:
 *
 *  1. Never lock an account out permanently. The brief is explicit: a few bad
 *     passwords must not brick an account. Login uses a PROGRESSIVE COOLDOWN
 *     that grows with consecutive failures and decays on its own, rather than a
 *     hard lock.
 *
 *  2. Never rely on IP alone. Universities, offices, and Indian mobile carriers
 *     put thousands of people behind one address — an IP-only limit would lock
 *     out a whole campus the moment one person fat-fingers a password. Every
 *     sensitive policy therefore has BOTH a per-subject limit (account or
 *     email) and a looser per-network limit, and the per-network one is sized
 *     to tolerate shared egress.
 *
 * Every value is overridable at runtime from /admin/settings; these are the
 * boot defaults used before an override row exists.
 */

export interface RateLimitPolicy {
  /** Stable key, also the `bucket` column value. */
  bucket: string;
  limit: number;
  windowSeconds: number;
  /** What the limit is counted against. */
  scope: "user" | "ip" | "email" | "global";
  description: string;
  /** Only failed attempts count toward the limit. */
  countFailuresOnly?: boolean;
}

export const RATE_LIMIT_POLICIES = {
  "auth.signup.ip": {
    bucket: "auth.signup.ip",
    limit: 5,
    windowSeconds: 3600,
    scope: "ip",
    description: "Signups per network per hour",
  },
  "auth.login.account": {
    bucket: "auth.login.account",
    limit: 10,
    windowSeconds: 900,
    scope: "email",
    countFailuresOnly: true,
    description: "Failed logins per account per 15 minutes (progressive cooldown applies first)",
  },
  "auth.login.ip": {
    bucket: "auth.login.ip",
    // Deliberately generous: one shared campus NAT must not lock out everyone.
    limit: 100,
    windowSeconds: 900,
    scope: "ip",
    countFailuresOnly: true,
    description: "Failed logins per network per 15 minutes",
  },
  "auth.forgot_password.email": {
    bucket: "auth.forgot_password.email",
    limit: 3,
    windowSeconds: 3600,
    scope: "email",
    description: "Password-reset requests per email per hour",
  },
  "auth.forgot_password.ip": {
    bucket: "auth.forgot_password.ip",
    limit: 5,
    windowSeconds: 3600,
    scope: "ip",
    description: "Password-reset requests per network per hour",
  },
  "auth.resend_verification.account": {
    bucket: "auth.resend_verification.account",
    limit: 3,
    windowSeconds: 3600,
    scope: "user",
    description: "Verification resends per account per hour",
  },
  "code.redeem.user": {
    bucket: "code.redeem.user",
    limit: 5,
    windowSeconds: 3600,
    scope: "user",
    countFailuresOnly: true,
    description: "Failed code redemptions per user per hour",
  },
  "code.redeem.ip": {
    bucket: "code.redeem.ip",
    limit: 10,
    windowSeconds: 3600,
    scope: "ip",
    countFailuresOnly: true,
    description: "Failed code redemptions per network identifier per hour",
  },
  "support.submit.user": {
    bucket: "support.submit.user",
    limit: 5,
    windowSeconds: 86400,
    scope: "user",
    description: "Support submissions per user per day",
  },
  "support.submit.ip": {
    bucket: "support.submit.ip",
    limit: 10,
    windowSeconds: 86400,
    scope: "ip",
    description: "Support submissions per network per day",
  },
  /*
   * Every admin API call, per staff account.
   *
   * Not an anti-abuse control in the usual sense — a legitimate operator will
   * never come close to it. It is a blast-radius limit: if a staff session is
   * ever stolen, this is what stops it enumerating every user and every ledger
   * entry at machine speed before anyone notices. Generous enough that normal
   * console use, including a page that fires several requests at once, never
   * touches it.
   *
   * Counts every attempt, not just failures: a successful bulk export is
   * exactly the thing being bounded here.
   */
  "admin.api.user": {
    bucket: "admin.api.user",
    limit: 600,
    windowSeconds: 300,
    scope: "user",
    description: "Admin API calls per staff account per 5 minutes",
  },
  "admin.login.account": {
    bucket: "admin.login.account",
    limit: 5,
    windowSeconds: 900,
    scope: "email",
    countFailuresOnly: true,
    description: "Failed admin logins per account per 15 minutes (2FA and Turnstile also required)",
  },
  "api.write.user": {
    bucket: "api.write.user",
    limit: 120,
    windowSeconds: 60,
    scope: "user",
    description: "Authenticated state-changing requests per user per minute",
  },
  "analytics.ingest.ip": {
    bucket: "analytics.ingest.ip",
    limit: 300,
    windowSeconds: 3600,
    scope: "ip",
    description: "Analytics beacons per network per hour",
  },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitBucket = keyof typeof RATE_LIMIT_POLICIES;

/**
 * Progressive cooldown for repeated login failures.
 *
 * Returns the number of seconds a subject must wait after `failures`
 * consecutive failures. Growth is roughly exponential but CAPPED, and the
 * counter decays with the rate-limit window, so the account always recovers on
 * its own. No number of failures produces a permanent lock.
 *
 *   1-2 failures ->  0s   (typos are normal)
 *   3            ->  5s
 *   4            -> 15s
 *   5            -> 30s
 *   6            -> 60s
 *   7            -> 120s
 *   8            -> 300s
 *   9+           -> 900s  (hard ceiling: 15 minutes)
 */
const COOLDOWN_LADDER = [0, 0, 5, 15, 30, 60, 120, 300] as const;
export const MAX_LOGIN_COOLDOWN_SECONDS = 900;

export function loginCooldownSeconds(failures: number): number {
  if (failures <= 0) return 0;
  const index = Math.min(failures - 1, COOLDOWN_LADDER.length - 1);
  const base = COOLDOWN_LADDER[index] ?? MAX_LOGIN_COOLDOWN_SECONDS;
  return failures >= COOLDOWN_LADDER.length ? MAX_LOGIN_COOLDOWN_SECONDS : base;
}

/**
 * Whether login should additionally demand a Turnstile challenge.
 *
 * The brief asks for Turnstile on signup always, and on login "after
 * suspicious or repeated attempts" — so a first honest login stays frictionless.
 */
export const LOGIN_CHALLENGE_AFTER_FAILURES = 3;

export function loginNeedsChallenge(failures: number, flagged: boolean): boolean {
  return flagged || failures >= LOGIN_CHALLENGE_AFTER_FAILURES;
}

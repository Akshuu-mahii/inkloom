/**
 * The error taxonomy.
 *
 * Every failure that reaches a client is an `AppError` with a stable machine
 * `code` and a message that is SAFE TO SHOW. Anything else — a driver error, a
 * constraint name, a stack — is caught at the API boundary and replaced with a
 * generic 500 carrying only a request id. Clients never see internals.
 */

export type ErrorCode =
  // --- auth (deliberately vague; see the note on enumeration below) ---
  | "INVALID_CREDENTIALS"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "EMAIL_NOT_VERIFIED"
  | "ACCOUNT_SUSPENDED"
  | "REAUTH_REQUIRED"
  | "TWO_FACTOR_REQUIRED"
  // --- validation / protocol ---
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "CSRF_REJECTED"
  | "ORIGIN_REJECTED"
  | "TURNSTILE_FAILED"
  | "IDEMPOTENCY_CONFLICT"
  // --- abuse ---
  | "RATE_LIMITED"
  // --- access codes ---
  | "CODE_UNAVAILABLE"
  | "CODE_ALREADY_REDEEMED"
  | "CODE_REDEMPTION_DISABLED"
  // --- credits ---
  | "INSUFFICIENT_CREDITS"
  | "REASON_REQUIRED"
  // --- system ---
  | "FEATURE_DISABLED"
  | "MAINTENANCE"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Safe, structured extras for the client. Never contains internals. */
  readonly details?: Record<string, unknown>;
  /** Retry hint in seconds, surfaced as the `Retry-After` header. */
  readonly retryAfter?: number;
  /**
   * Internal-only context for logs and Sentry. NEVER serialised to a client.
   */
  readonly context?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      status?: number;
      details?: Record<string, unknown>;
      retryAfter?: number;
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? statusForCode(code);
    this.details = options.details;
    this.retryAfter = options.retryAfter;
    this.context = options.context;
  }
}

function statusForCode(code: ErrorCode): number {
  switch (code) {
    case "VALIDATION_ERROR":
      return 400;
    case "UNAUTHENTICATED":
    case "INVALID_CREDENTIALS":
      return 401;
    case "TWO_FACTOR_REQUIRED":
    case "REAUTH_REQUIRED":
      return 401;
    case "FORBIDDEN":
    case "EMAIL_NOT_VERIFIED":
    case "ACCOUNT_SUSPENDED":
    case "CSRF_REJECTED":
    case "ORIGIN_REJECTED":
    case "TURNSTILE_FAILED":
    case "FEATURE_DISABLED":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "CODE_ALREADY_REDEEMED":
    case "IDEMPOTENCY_CONFLICT":
      return 409;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "UNSUPPORTED_MEDIA_TYPE":
      return 415;
    case "CODE_UNAVAILABLE":
    case "INSUFFICIENT_CREDITS":
    case "REASON_REQUIRED":
      return 422;
    case "RATE_LIMITED":
      return 429;
    case "CODE_REDEMPTION_DISABLED":
    case "MAINTENANCE":
    case "SERVICE_UNAVAILABLE":
      return 503;
    case "INTERNAL_ERROR":
    default:
      return 500;
  }
}

/**
 * Canonical user-facing messages.
 *
 * The auth and access-code strings are deliberately uniform. `INVALID_CREDENTIALS`
 * is returned for an unknown email, a wrong password, and an unverified account
 * alike, so that response bodies, status codes and timings cannot be used to
 * discover whether an address has an account. Likewise `CODE_UNAVAILABLE`
 * covers "no such code", "expired", "paused", "revoked", "cohort mismatch" and
 * "campaign exhausted" — the real reason is recorded in `security_events` for
 * operators, never disclosed to the caller.
 */
export const SAFE_MESSAGES: Record<ErrorCode, string> = {
  INVALID_CREDENTIALS: "Those details don't match an account. Check your email and password.",
  UNAUTHENTICATED: "Please sign in to continue.",
  FORBIDDEN: "You don't have access to that.",
  EMAIL_NOT_VERIFIED: "Verify your email address to continue.",
  ACCOUNT_SUSPENDED: "This account is suspended. Contact support if you think that's a mistake.",
  REAUTH_REQUIRED: "Please confirm your password to continue.",
  TWO_FACTOR_REQUIRED: "Enter your two-factor code to continue.",
  VALIDATION_ERROR: "Some of the information provided isn't valid.",
  NOT_FOUND: "Not found.",
  CONFLICT: "That conflicts with something that already exists.",
  PAYLOAD_TOO_LARGE: "That request is too large.",
  UNSUPPORTED_MEDIA_TYPE: "That content type isn't supported.",
  CSRF_REJECTED: "Your session couldn't be verified. Refresh the page and try again.",
  ORIGIN_REJECTED: "Your session couldn't be verified. Refresh the page and try again.",
  TURNSTILE_FAILED: "We couldn't verify that you're human. Please try again.",
  IDEMPOTENCY_CONFLICT: "This request was already submitted with different content.",
  RATE_LIMITED: "Too many attempts. Please wait a moment and try again.",
  CODE_UNAVAILABLE: "This code is invalid or unavailable.",
  CODE_ALREADY_REDEEMED: "This code has already been redeemed.",
  CODE_REDEMPTION_DISABLED: "Code redemption is temporarily unavailable.",
  INSUFFICIENT_CREDITS: "Not enough credits for that.",
  REASON_REQUIRED: "A reason is required for this action.",
  FEATURE_DISABLED: "That feature isn't available yet.",
  MAINTENANCE: "Inkloom is briefly unavailable for maintenance. Please try again shortly.",
  SERVICE_UNAVAILABLE: "Inkloom is temporarily unavailable. Please try again in a moment.",
  INTERNAL_ERROR: "Something went wrong on our end. Please try again.",
};

/** Build an AppError using the canonical safe message for its code. */
export function fail(
  code: ErrorCode,
  options?: ConstructorParameters<typeof AppError>[2],
): AppError {
  return new AppError(code, SAFE_MESSAGES[code], options);
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * A dependency is down, as opposed to the code being wrong.
 *
 * WHY THIS EXISTS. A database outage used to surface as `INTERNAL_ERROR` /
 * 500, which is the status that means "this request is broken" — the one thing
 * an outage is not. Everything downstream reads that distinction: a browser and
 * a proxy may retry a 503 and must not retry a 500, `Retry-After` is only
 * meaningful on the former, an uptime check that alerts on 5xx cannot tell a
 * bad deploy from a database failover, and a login attempt during a thirty
 * second Neon restart told the user their credentials were the problem.
 *
 * DELIBERATELY NARROW. Only failures to REACH or be ADMITTED BY the database
 * count. A constraint violation, a syntax error, a type mismatch — anything the
 * database answered — stays a 500, because those are defects and must not be
 * dressed up as weather. Getting that backwards would hide real bugs behind a
 * status that invites a retry.
 *
 * Drizzle wraps driver errors, so the cause chain is walked; see
 * `isUniqueViolation`, which learned the same lesson the hard way.
 */
const UNAVAILABLE_SQLSTATES = new Set([
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
  "08007", // transaction_resolution_unknown
  "08P01", // protocol_violation
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now — a Postgres that is still starting up
]);

/** Socket-level failures, which carry an errno rather than a SQLSTATE. */
const UNAVAILABLE_ERRNOS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

/**
 * Messages `pg` produces with no code at all, which is exactly the case that
 * made this hard: a pool whose connection dies mid-query throws a plain Error.
 */
const UNAVAILABLE_MESSAGES = [
  "connection terminated",
  "timeout exceeded when trying to connect",
  "client has encountered a connection error",
  "server closed the connection unexpectedly",
  "terminating connection due to administrator command",
];

export function isDependencyUnavailable(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false;

  const code = (error as { code?: unknown }).code;
  if (
    typeof code === "string" &&
    (UNAVAILABLE_SQLSTATES.has(code) || UNAVAILABLE_ERRNOS.has(code))
  ) {
    return true;
  }

  const message = (error as { message?: unknown }).message;
  if (typeof message === "string") {
    const lower = message.toLowerCase();
    /*
     * NOT "cannot use a pool after calling end on the pool". That message also
     * mentions the pool and also stops queries working, but it means this
     * application closed its own connection too early — a bug of ours, and one
     * that has happened. It must keep returning 500 and must not invite a retry
     * that will fail identically.
     */
    if (UNAVAILABLE_MESSAGES.some((needle) => lower.includes(needle))) return true;
  }

  if ("cause" in error) {
    return isDependencyUnavailable((error as { cause?: unknown }).cause, depth + 1);
  }
  return false;
}

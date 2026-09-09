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

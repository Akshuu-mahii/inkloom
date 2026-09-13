/**
 * OpenAPI 3.1 document, generated FROM the Zod schemas.
 *
 * Generated rather than hand-written, because a hand-written spec drifts from
 * the code the moment someone adds a field. Every request body below is
 * converted from the same `z.object` the server validates against, so the
 * document cannot describe a shape the API will not accept.
 *
 * Emitted to `openapi.json` by `pnpm openapi:emit`, and served at
 * `/api/v1/openapi.json`.
 */
import { z } from "zod";
import * as schemas from "./schemas/index";

/** The response envelope every endpoint returns. */
const envelope = (dataSchema: unknown) => ({
  type: "object",
  required: ["data", "error", "requestId"],
  properties: {
    data: dataSchema,
    error: { $ref: "#/components/schemas/Error" },
    requestId: { type: "string", example: "req_01JQ2M8V4T0000000000000000" },
  },
});

/** Convert a Zod schema to JSON Schema, inlined for a self-contained document. */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >;
}

interface OperationOptions {
  summary: string;
  description: string;
  tag: string;
  body?: z.ZodType;
  query?: z.ZodType;
  responses: Record<string, { description: string; schema?: unknown }>;
  security?: boolean;
  rateLimit?: string;
}

function operation(options: OperationOptions) {
  const responses: Record<string, unknown> = {};
  for (const [status, response] of Object.entries(options.responses)) {
    responses[status] = {
      description: response.description,
      content: {
        "application/json": {
          schema: response.schema ?? envelope({ type: "object" }),
        },
      },
    };
  }

  // Every endpoint can produce these, so they are documented once, here.
  responses["400"] ??= { description: "Validation failed", content: errorContent };
  responses["429"] ??= { description: "Rate limited", content: errorContent };
  responses["500"] ??= { description: "Unexpected error", content: errorContent };

  return {
    summary: options.summary,
    description:
      options.description + (options.rateLimit ? `\n\n**Rate limit:** ${options.rateLimit}` : ""),
    tags: [options.tag],
    ...(options.security ? { security: [{ sessionCookie: [] }] } : { security: [] }),
    ...(options.query
      ? {
          parameters: Object.entries(
            (jsonSchema(options.query).properties ?? {}) as Record<string, unknown>,
          ).map(([name, schema]) => ({
            name,
            in: "query",
            required: false,
            schema,
          })),
        }
      : {}),
    ...(options.body
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: jsonSchema(options.body) } },
          },
        }
      : {}),
    responses,
  };
}

const errorContent = {
  "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } },
};

export function buildOpenApiDocument(origin = "https://inkloom.art") {
  return {
    openapi: "3.1.0",
    info: {
      title: "Inkloom API",
      version: "1.0.0",
      description: [
        "The Inkloom V1 API.",
        "",
        "**Authentication** is a session cookie, `__Host-inkloom_session`, set by",
        "the sign-in endpoints. It is HttpOnly, so JavaScript cannot read it, and",
        "it is sent automatically by the browser on same-origin requests. There is",
        "no bearer token and no API key in V1.",
        "",
        "**Every response** uses the same envelope: `{ data, error, requestId }`.",
        "On success `error` is null; on failure `data` is null and `error` carries",
        "a stable machine `code` plus a message that is safe to show a user.",
        "Quote the `requestId` when reporting a problem.",
        "",
        "**State-changing requests** must be `application/json` and carry an",
        "`Origin` header matching the app. Form-encoded bodies are refused, because",
        "that is the shape a cross-origin CSRF form produces.",
        "",
        "**Not in V1:** payments, credit purchase, and logo generation. The",
        "`generation_enabled` and `payments_enabled` feature flags exist and are",
        "off; no endpoint here will produce a logo.",
      ].join("\n"),
      contact: { name: "Inkloom support", email: "support@inkloom.art" },
      license: { name: "Proprietary" },
    },

    servers: [
      { url: `${origin}/api/v1`, description: "This environment" },
      { url: "https://inkloom.art/api/v1", description: "Production" },
      { url: "https://staging.inkloom.art/api/v1", description: "Staging" },
    ],

    tags: [
      { name: "Authentication", description: "Sign up, sign in, verification and password reset." },
      { name: "User", description: "The signed-in user's own account." },
      { name: "Credits", description: "Balance, history and access-code redemption." },
      { name: "Support", description: "Support requests." },
      { name: "Analytics", description: "First-party product events." },
      {
        name: "Admin",
        description: "Staff only. Every endpoint re-checks permission server-side.",
      },
      { name: "Health", description: "Liveness and readiness probes." },
    ],

    components: {
      securitySchemes: {
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-inkloom_session",
          description:
            "Set by sign-in. HttpOnly, Secure, SameSite=Lax, host-only. In local development over plain HTTP the `__Host-` prefix is not legal, so the name falls back to `inkloom_session`.",
        },
      },
      schemas: {
        Error: {
          type: ["object", "null"],
          properties: {
            code: {
              type: "string",
              description: "Stable machine code. Safe to branch on.",
              enum: [
                "INVALID_CREDENTIALS",
                "UNAUTHENTICATED",
                "FORBIDDEN",
                "EMAIL_NOT_VERIFIED",
                "ACCOUNT_SUSPENDED",
                "REAUTH_REQUIRED",
                "TWO_FACTOR_REQUIRED",
                "VALIDATION_ERROR",
                "NOT_FOUND",
                "CONFLICT",
                "PAYLOAD_TOO_LARGE",
                "UNSUPPORTED_MEDIA_TYPE",
                "CSRF_REJECTED",
                "ORIGIN_REJECTED",
                "TURNSTILE_FAILED",
                "IDEMPOTENCY_CONFLICT",
                "RATE_LIMITED",
                "CODE_UNAVAILABLE",
                "CODE_ALREADY_REDEEMED",
                "CODE_REDEMPTION_DISABLED",
                "INSUFFICIENT_CREDITS",
                "REASON_REQUIRED",
                "FEATURE_DISABLED",
                "MAINTENANCE",
                "INTERNAL_ERROR",
              ],
            },
            message: { type: "string", description: "Safe to display to a user verbatim." },
            details: { type: "object", additionalProperties: true },
          },
        },
        ErrorEnvelope: envelope({ type: "null" }),
      },
    },

    paths: {
      // --- Authentication -------------------------------------------------
      "/auth/signup": {
        post: operation({
          summary: "Create an account",
          description:
            "Creates an account and sends a verification email.\n\n" +
            "Returns an **identical** response whether or not the address is already registered. That is deliberate: a different response would let anyone test which addresses have accounts.",
          tag: "Authentication",
          body: schemas.signupSchema,
          rateLimit: "5 per network per hour. Turnstile always required.",
          responses: {
            "200": { description: "Accepted. Check the inbox." },
            "403": { description: "Turnstile failed, or registration is paused" },
          },
        }),
      },
      "/auth/login": {
        post: operation({
          summary: "Sign in",
          description:
            "Signs in and sets the session cookie.\n\n" +
            "An unknown address, a wrong password and an unverified account all return the same `INVALID_CREDENTIALS` error. Repeated failures trigger a progressive cooldown (capped, never a permanent lock) and then require a Turnstile challenge.\n\n" +
            "If the account has two-factor enabled, no session is issued: the response says `twoFactorRequired` and the caller must complete `/auth/two-factor/verify`.",
          tag: "Authentication",
          body: schemas.loginSchema,
          rateLimit: "Progressive cooldown per account; 100 failures per network per 15 minutes.",
          responses: {
            "200": { description: "Signed in, or a two-factor challenge issued" },
            "401": { description: "Invalid credentials" },
          },
        }),
      },
      "/auth/logout": {
        post: operation({
          summary: "Sign out",
          description: "Ends the current session and clears the cookie.",
          tag: "Authentication",
          security: true,
          responses: { "200": { description: "Signed out" } },
        }),
      },
      "/auth/logout-all": {
        post: operation({
          summary: "Sign out everywhere",
          description: "Ends every session for this account, including the current one.",
          tag: "Authentication",
          security: true,
          responses: { "200": { description: "All sessions ended" } },
        }),
      },
      "/auth/verify-email": {
        post: operation({
          summary: "Confirm an email address",
          description:
            "Confirms the address using the token from the verification email, and signs the user in.\n\n" +
            "The token is a signed, expiring value rather than a stored one, so presenting a still-valid token twice succeeds idempotently — it grants nothing extra.",
          tag: "Authentication",
          body: schemas.verifyEmailSchema,
          responses: { "200": { description: "Verified and signed in" } },
        }),
      },
      "/auth/resend-verification": {
        post: operation({
          summary: "Resend the verification email",
          description: "Always returns the same response, whether or not the address exists.",
          tag: "Authentication",
          body: schemas.resendVerificationSchema,
          rateLimit: "3 per account per hour.",
          responses: { "200": { description: "Accepted" } },
        }),
      },
      "/auth/forgot-password": {
        post: operation({
          summary: "Request a password reset",
          description:
            "Sends a single-use reset link that expires in one hour.\n\n" +
            "Issuing a new link **invalidates any previous one** for that account. The response is identical for a known and an unknown address.",
          tag: "Authentication",
          body: schemas.forgotPasswordSchema,
          rateLimit: "3 per email per hour; 5 per network per hour. Turnstile required.",
          responses: { "200": { description: "Accepted" } },
        }),
      },
      "/auth/reset-password": {
        post: operation({
          summary: "Set a new password with a reset token",
          description:
            "Consumes the token, sets the password, and **revokes every existing session** — the point of a reset is to evict anyone who had one.",
          tag: "Authentication",
          body: schemas.resetPasswordSchema,
          responses: {
            "200": { description: "Password changed" },
            "400": { description: "The link is invalid, expired or already used" },
          },
        }),
      },
      "/auth/change-password": {
        post: operation({
          summary: "Change your password",
          description:
            "Requires the current password. Rotates the session and, by default, signs out every other device. Sends a notification email.",
          tag: "Authentication",
          security: true,
          body: schemas.changePasswordSchema,
          responses: { "200": { description: "Password changed" } },
        }),
      },
      "/auth/two-factor/verify": {
        post: operation({
          summary: "Complete a two-factor challenge",
          description: "Exchanges a TOTP code for a real session.",
          tag: "Authentication",
          body: schemas.twoFactorSchema,
          responses: {
            "200": { description: "Signed in" },
            "401": { description: "Invalid code" },
          },
        }),
      },

      // --- User -----------------------------------------------------------
      "/me": {
        get: operation({
          summary: "Your account",
          description:
            "Profile, credit balance, verification state and the platform feature flags.\n\n" +
            "Never includes a password hash, a session token, or a raw IP — the response is built field by field rather than spread from a row, so a new sensitive column cannot leak through it.",
          tag: "User",
          security: true,
          responses: { "200": { description: "Your account" } },
        }),
        patch: operation({
          summary: "Update your profile",
          description:
            "Updates display name, company and time zone.\n\n" +
            "`role`, `status`, `balance` and `userId` are **not** accepted here and are stripped if sent — those are decided by the server.",
          tag: "User",
          security: true,
          body: schemas.updateMeSchema,
          responses: { "200": { description: "Saved" } },
        }),
      },
      "/me/export": {
        post: operation({
          summary: "Export your data",
          description:
            "Returns everything held about the account: profile, credit ledger, redemptions, consents and sessions. Excludes internal staff notes and anything belonging to another user.",
          tag: "User",
          security: true,
          responses: { "200": { description: "The export" } },
        }),
      },
      "/me/sessions": {
        get: operation({
          summary: "List your sessions",
          description:
            "Every device signed in to this account. Returns a coarse device label only — never a session token, an IP address or a fingerprint.",
          tag: "User",
          security: true,
          responses: { "200": { description: "Your sessions" } },
        }),
      },
      "/me/sessions/{id}": {
        delete: operation({
          summary: "Sign out one device",
          description:
            "Ends a single session. Scoped to your own sessions: another user's id returns 404, not 403, so the response cannot confirm that it exists.",
          tag: "User",
          security: true,
          responses: {
            "200": { description: "Session ended" },
            "404": { description: "No such session on this account" },
          },
        }),
      },
      "/me/notifications": {
        get: operation({
          summary: "Your notifications",
          description: "In-app notices, newest first.",
          tag: "User",
          security: true,
          query: schemas.paginationSchema,
          responses: { "200": { description: "Notifications" } },
        }),
      },
      "/me/notification-preferences": {
        patch: operation({
          summary: "Update email preferences",
          description:
            "Security email cannot be disabled and is not accepted here — a user must always learn that their password changed.",
          tag: "User",
          security: true,
          body: schemas.notificationPreferencesSchema,
          responses: { "200": { description: "Saved" } },
        }),
      },

      // --- Credits ---------------------------------------------------------
      "/credits": {
        get: operation({
          summary: "Your credit balance",
          description:
            "Read from the wallet, which always reconciles with the ledger. `spendable` is false in V1 because generation is not enabled.",
          tag: "Credits",
          security: true,
          responses: { "200": { description: "Balance" } },
        }),
      },
      "/credits/history": {
        get: operation({
          summary: "Your credit history",
          description:
            "Every ledger entry for your account, newest first, keyset-paginated. Scoped to the caller — there is no `userId` parameter to tamper with.",
          tag: "Credits",
          security: true,
          query: schemas.paginationSchema,
          responses: { "200": { description: "Ledger entries" } },
        }),
      },
      "/access-codes/redeem": {
        post: operation({
          summary: "Redeem an access code",
          description:
            "Redeems a code and grants its credits, atomically.\n\n" +
            "The code is normalised (case, spaces and hyphens are ignored) and matched by keyed HMAC — the plaintext is never stored. Requires a verified email.\n\n" +
            "Concurrent or repeated attempts cannot double-grant: a unique database constraint means exactly one redemption per user per campaign, and a losing request is answered with the winner's result rather than an error.\n\n" +
            "Failures return one of three deliberately uninformative messages, so campaign existence and state cannot be mapped.",
          tag: "Credits",
          security: true,
          body: schemas.redeemCodeSchema,
          rateLimit: "5 failed attempts per user per hour; 10 per network per hour.",
          responses: {
            "200": { description: "Credits granted, or already redeemed" },
            "403": { description: "Email not verified, or account suspended" },
            "409": { description: "Already redeemed" },
            "422": { description: "The code is invalid or unavailable" },
            "503": { description: "Redemption is paused" },
          },
        }),
      },

      // --- Support ----------------------------------------------------------
      "/support": {
        post: operation({
          summary: "Submit a support request",
          description:
            "Works signed in or anonymously. Anonymous submissions require Turnstile. Returns a short human-quotable reference.",
          tag: "Support",
          body: schemas.supportSchema,
          rateLimit: "5 per user per day; 10 per network per day.",
          responses: { "200": { description: "Received" } },
        }),
      },
      "/support/{id}": {
        get: operation({
          summary: "Check a support request",
          description:
            "Status of one of your own requests, by id or reference. Someone else's reference returns 404.",
          tag: "Support",
          security: true,
          responses: {
            "200": { description: "Request status" },
            "404": { description: "Not found on this account" },
          },
        }),
      },

      // --- Analytics ---------------------------------------------------------
      "/analytics": {
        post: operation({
          summary: "Record a product event",
          description:
            "First-party analytics. The event name must be one of a fixed allowlist and properties are bounded scalars, so an email address or an access code cannot be recorded. The user id is attached server-side from the session, never accepted from the client.",
          tag: "Analytics",
          body: schemas.analyticsEventSchema,
          rateLimit: "300 per network per hour.",
          responses: { "200": { description: "Recorded" } },
        }),
      },

      // --- Admin -------------------------------------------------------------
      ...adminPaths(),

      // --- Health -------------------------------------------------------------
      "/../health": {
        get: {
          summary: "Liveness",
          description:
            'Served at `/api/health`, outside the versioned API. Returns `{ status: "ok" }` and deliberately nothing else — no version, no hostname, no dependency detail.',
          tags: ["Health"],
          security: [],
          responses: { "200": { description: "Alive" } },
        },
      },
      "/../ready": {
        get: {
          summary: "Readiness",
          description:
            "Served at `/api/ready`. Checks the database. Returns 503 with the literal string `unavailable` on failure — the driver error goes to the log, never to the caller.",
          tags: ["Health"],
          security: [],
          responses: {
            "200": { description: "Ready" },
            "503": { description: "Not ready" },
          },
        },
      },
    },
  };
}

/**
 * Admin operations.
 *
 * Every one of these is gated server-side by `requirePermission`, which reads
 * the caller's role from the database. They additionally require a verified
 * email, enrolled two-factor authentication, and — for anything that moves
 * credits or privilege — a recent authentication and a written reason.
 */
function adminPaths() {
  const adminNote =
    "\n\n**Access:** staff only. Requires the listed permission, a verified email and enrolled two-factor authentication.";

  return {
    "/admin/overview": {
      get: operation({
        summary: "Platform overview",
        description:
          "Users, sessions, credits, redemptions, the early-access funnel and recent events." +
          adminNote,
        tag: "Admin",
        security: true,
        responses: {
          "200": { description: "Overview" },
          "403": { description: "Insufficient permission" },
        },
      }),
    },
    "/admin/users": {
      get: operation({
        summary: "Search users",
        description:
          "Search by email, name or id, with status and verification filters." + adminNote,
        tag: "Admin",
        security: true,
        query: schemas.adminUserListSchema,
        responses: { "200": { description: "Matching users" } },
      }),
    },
    "/admin/users/{id}": {
      get: operation({
        summary: "User detail",
        description:
          "Profile, credits, redemptions, sessions, security events and internal notes.\n\n" +
          "Never includes a password, a password hash, a session token or a reset token — the `accounts` table is not queried at all." +
          adminNote,
        tag: "Admin",
        security: true,
        responses: { "200": { description: "User detail" } },
      }),
    },
    "/admin/users/{id}/suspend": {
      post: operation({
        summary: "Suspend an account",
        description:
          "Suspends the account, ends its sessions and emails the user. A written reason is mandatory and is recorded in the audit log." +
          adminNote,
        tag: "Admin",
        security: true,
        body: schemas.suspendUserSchema,
        responses: { "200": { description: "Suspended" } },
      }),
    },
    "/admin/users/{id}/unsuspend": {
      post: operation({
        summary: "Restore an account",
        description: "Reverses a suspension. A reason is mandatory." + adminNote,
        tag: "Admin",
        security: true,
        body: schemas.unsuspendUserSchema,
        responses: { "200": { description: "Restored" } },
      }),
    },
    "/admin/users/{id}/revoke-sessions": {
      post: operation({
        summary: "Sign a user out everywhere",
        description: "Ends every session for the account." + adminNote,
        tag: "Admin",
        security: true,
        responses: { "200": { description: "Sessions revoked" } },
      }),
    },
    "/admin/access-codes": {
      get: operation({
        summary: "List campaigns",
        description:
          "Returns the masked code only. The HMAC fingerprint is never exposed." + adminNote,
        tag: "Admin",
        security: true,
        responses: { "200": { description: "Campaigns" } },
      }),
      post: operation({
        summary: "Create a campaign",
        description:
          "Creates a campaign and returns the full code **exactly once**. Only the keyed HMAC is stored, so the plaintext is not recoverable afterwards.\n\n" +
          "Reserved to `super_admin`, and requires a recent authentication and a written reason." +
          adminNote,
        tag: "Admin",
        security: true,
        body: schemas.createCampaignSchema,
        responses: {
          "200": { description: "Created. The response contains the only copy of the code." },
          "409": { description: "That code is already in use" },
        },
      }),
    },
    "/admin/access-codes/{id}": {
      get: operation({
        summary: "Campaign detail",
        description: "Configuration, redemptions and refused attempts." + adminNote,
        tag: "Admin",
        security: true,
        responses: { "200": { description: "Campaign" } },
      }),
      patch: operation({
        summary: "Edit a campaign",
        description:
          "Name, description, limits and expiry. The credit amount and the code itself cannot be changed — altering either would retroactively change what an already-distributed code means." +
          adminNote,
        tag: "Admin",
        security: true,
        body: schemas.updateCampaignSchema,
        responses: { "200": { description: "Saved" } },
      }),
    },
    "/admin/access-codes/{id}/pause": {
      post: operation({
        summary: "Pause or resume a campaign",
        description: "Reversible. Redemptions are refused while paused." + adminNote,
        tag: "Admin",
        security: true,
        body: schemas.campaignActionSchema,
        responses: { "200": { description: "Paused or resumed" } },
      }),
    },
    "/admin/access-codes/{id}/revoke": {
      post: operation({
        summary: "Revoke a campaign",
        description:
          "**Permanent.** A revoked campaign can never be re-enabled. Use when a code has leaked." +
          adminNote,
        tag: "Admin",
        security: true,
        body: schemas.campaignActionSchema,
        responses: { "200": { description: "Revoked" }, "409": { description: "Already revoked" } },
      }),
    },
    "/admin/credits/adjust": {
      post: operation({
        summary: "Adjust a balance",
        description:
          "Grants or deducts credits. A written reason is mandatory and is stored on the ledger entry itself.\n\n" +
          "Idempotent: a repeated key returns the original entry instead of applying twice. A balance can never go negative. Reserved to `super_admin`, and requires a recent authentication." +
          adminNote,
        tag: "Admin",
        security: true,
        body: schemas.adjustCreditsSchema,
        responses: {
          "200": { description: "Applied" },
          "422": { description: "Not enough credits to deduct" },
        },
      }),
    },
    "/admin/credits/reverse": {
      post: operation({
        summary: "Reverse an adjustment",
        description:
          "Appends a compensating entry. The original is never edited or deleted — a database trigger makes that impossible. An entry can only be reversed once." +
          adminNote,
        tag: "Admin",
        security: true,
        body: schemas.reverseCreditsSchema,
        responses: {
          "200": { description: "Reversed" },
          "409": { description: "Already reversed" },
        },
      }),
    },
    "/admin/credits/ledger": {
      get: operation({
        summary: "The credit ledger",
        description: "Every entry across all users, newest first." + adminNote,
        tag: "Admin",
        security: true,
        query: schemas.ledgerQuerySchema,
        responses: { "200": { description: "Ledger" } },
      }),
    },
    "/admin/credits/reconcile": {
      post: operation({
        summary: "Reconcile wallets against the ledger",
        description:
          "Re-sums every ledger and reports wallets that disagree. Read-only unless `?repair=true`, which only ever corrects the cache toward the ledger — the ledger is never rewritten to match a wallet. Repair is `super_admin` only." +
          adminNote,
        tag: "Admin",
        security: true,
        responses: { "200": { description: "Reconciliation result" } },
      }),
    },
    "/admin/audit": {
      get: operation({
        summary: "The audit log",
        description:
          "Append-only, enforced by a database trigger. The application cannot edit or delete a row." +
          adminNote,
        tag: "Admin",
        security: true,
        query: schemas.auditQuerySchema,
        responses: { "200": { description: "Audit events" } },
      }),
    },
    "/admin/security": {
      get: operation({
        summary: "Security events",
        description:
          "Failed logins, rate-limit blocks, refused redemptions, abuse flags and admin activity." +
          adminNote,
        tag: "Admin",
        security: true,
        query: schemas.securityQuerySchema,
        responses: { "200": { description: "Security events" } },
      }),
    },
    "/admin/support": {
      get: operation({
        summary: "The support queue",
        description: "Support requests, filterable by status and priority." + adminNote,
        tag: "Admin",
        security: true,
        query: schemas.supportQuerySchema,
        responses: { "200": { description: "Support requests" } },
      }),
    },
    "/admin/settings": {
      get: operation({
        summary: "Feature flags and settings",
        description: "Current values plus their declared defaults and risk levels." + adminNote,
        tag: "Admin",
        security: true,
        responses: { "200": { description: "Settings" } },
      }),
      patch: operation({
        summary: "Change settings",
        description:
          "Reserved to `super_admin`. A high-risk key additionally requires the typed confirmation `I UNDERSTAND`. An unknown key is rejected, and a malformed value fails validation rather than being stored." +
          adminNote,
        tag: "Admin",
        security: true,
        body: schemas.updateSettingsSchema,
        responses: { "200": { description: "Saved" } },
      }),
    },
    "/admin/system": {
      get: operation({
        summary: "System health",
        description:
          "Database latency, email delivery, wallet drift and integration status." + adminNote,
        tag: "Admin",
        security: true,
        responses: { "200": { description: "System health" } },
      }),
    },
    "/admin/system/emergency": {
      post: operation({
        summary: "Emergency controls",
        description:
          "Pause signups, pause redemption, sign out every user, or sign out every other admin.\n\n" +
          "Reserved to `super_admin`. Requires a recent authentication, a written reason, and the action name typed back as confirmation. Recorded as a critical security event." +
          adminNote,
        tag: "Admin",
        security: true,
        body: schemas.emergencySchema,
        responses: { "200": { description: "Applied" } },
      }),
    },
  };
}

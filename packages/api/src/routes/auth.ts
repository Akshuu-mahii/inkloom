/**
 * Authentication endpoints.
 *
 * These wrap Better Auth rather than reimplementing it: hashing, token
 * generation and session cryptography all stay inside the audited library. What
 * lives here is the policy the brief requires around it — Turnstile, rate
 * limiting, progressive cooldown, enumeration protection, consent capture and
 * security-event recording.
 *
 * THE ENUMERATION RULE, which shapes nearly every handler below:
 * a caller must never be able to tell whether an email address has an account.
 * That means signup, login and forgot-password all return the SAME response
 * whether or not the address exists, and take a similar amount of time. The
 * real outcome goes to `security_events` for operators.
 */
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { newId, user as userTable, userConsent } from "@inkloom/db";
import { loginNeedsChallenge } from "@inkloom/core/rate-limit";
import { safeRedirectPath } from "@inkloom/core/security";
import { templates } from "@inkloom/email";
import type { Env } from "../context";
import { apiError, ok } from "../lib/response";
import { body, validateBody } from "../middleware/validate";
import { bySubjectIp, rateLimit } from "../middleware/rate-limit";
import { requireAuth } from "../middleware/auth";
import {
  changePasswordSchema,
  twoFactorSchema,
  forgotPasswordSchema,
  loginSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  signupSchema,
  verifyEmailSchema,
  type LoginInput,
  type SignupInput,
} from "../schemas/index";

export const authRoutes = new Hono<Env>();

/**
 * A single generic response for every "did this email exist?" flow.
 * Identical body, identical status, whatever actually happened.
 */
const NEUTRAL_EMAIL_RESPONSE = {
  success: true,
  message: "If that address needs an email from us, it's on its way. Check your inbox.",
};

// ---------------------------------------------------------------------------
// POST /auth/signup
// ---------------------------------------------------------------------------
authRoutes.post(
  "/signup",
  rateLimit({ bucket: "auth.signup.ip", subject: bySubjectIp }),
  validateBody(signupSchema),
  async (c) => {
    const input = body<SignupInput>(c);
    const { auth, db, config, settings, turnstile, audit, logger } = c.get("services");

    // Operator kill switch, checked server-side on every attempt.
    if (!(await settings.isEnabled("signup_enabled"))) {
      throw apiError("FEATURE_DISABLED", {
        details: { reason: "New registrations are paused right now." },
      });
    }

    // Turnstile is always required on signup, per the brief.
    const verified = await turnstile.verify(input.turnstileToken, c.get("clientIp"));
    if (!verified.success) {
      await audit.security({
        type: "turnstile_failed",
        severity: "warning",
        targetEmail: input.email,
        ipHash: c.get("ipHash"),
        requestId: c.get("requestId"),
        metadata: { flow: "signup", errorCodes: verified.errorCodes },
      });
      throw apiError("TURNSTILE_FAILED");
    }

    let createdUserId: string | null = null;

    try {
      const result = await auth.api.signUpEmail({
        body: { email: input.email, password: input.password, name: input.name },
        headers: c.req.raw.headers,
      });

      /**
       * Better Auth does not throw on a duplicate address while
       * `requireEmailVerification` is on — that is its own enumeration defence.
       * It returns a user-shaped object carrying a freshly generated id that was
       * never written. Confirming the row actually exists is what distinguishes
       * a real signup from a duplicate; without it, the follow-up consent insert
       * fails a foreign key and turns a routine duplicate into a 500.
       */
      const candidateId = result?.user?.id ?? null;
      const persisted = candidateId
        ? await db.query.user.findFirst({ where: eq(userTable.id, candidateId) })
        : null;
      createdUserId = persisted ? candidateId : null;

      if (!persisted) {
        logger.info("signup_duplicate", {});
        await audit.security({
          type: "login_failed",
          severity: "info",
          targetEmail: input.email,
          ipHash: c.get("ipHash"),
          requestId: c.get("requestId"),
          metadata: { flow: "signup_duplicate" },
        });
        return ok(c, { ...NEUTRAL_EMAIL_RESPONSE, nextPath: "/auth/check-email" });
      }
    } catch {
      // An already-registered address lands here. We must NOT say so.
      // Instead: record it, send the existing account a "someone tried to sign
      // up with your address" nudge via the normal verification path, and
      // return the same neutral response a fresh signup gets.
      logger.info("signup_rejected", { reason: "duplicate_or_invalid" });
      await audit.security({
        type: "login_failed",
        severity: "info",
        targetEmail: input.email,
        ipHash: c.get("ipHash"),
        requestId: c.get("requestId"),
        metadata: { flow: "signup_duplicate" },
      });
      return ok(c, {
        ...NEUTRAL_EMAIL_RESPONSE,
        nextPath: "/auth/check-email",
      });
    }

    if (createdUserId) {
      // Record consent as an auditable, timestamped fact rather than a boolean
      // on the user row: "what did they agree to, and when" must be answerable
      // for any point in time.
      const consents = [
        { type: "terms" as const, granted: true },
        { type: "privacy" as const, granted: true },
        { type: "marketing_email" as const, granted: input.marketingOptIn },
      ];
      for (const consent of consents) {
        await db.insert(userConsent).values({
          id: newId("cns"),
          userId: createdUserId,
          type: consent.type,
          granted: consent.granted,
          documentVersion: "2026-09-01",
          source: "signup",
          ipHash: c.get("ipHash"),
        });
      }

      // First-touch attribution. Never contains PII.
      if (input.utm) {
        await db
          .update(userTable)
          .set({
            signupUtm: {
              source: input.utm.source ?? "",
              medium: input.utm.medium ?? "",
              campaign: input.utm.campaign ?? "",
              referrer: input.utm.referrer ?? "",
              landingPath: input.utm.landingPath ?? "",
            },
            earlyAccessJoinedAt: new Date(),
          })
          .where(eq(userTable.id, createdUserId));
      }

      await audit.recordStandalone({
        action: "user.signup",
        actorType: "user",
        actorId: createdUserId,
        targetType: "user",
        targetId: createdUserId,
        metadata: { marketingOptIn: input.marketingOptIn },
        requestId: c.get("requestId"),
        ipHash: c.get("ipHash"),
      });
    }

    void config;
    return ok(c, { ...NEUTRAL_EMAIL_RESPONSE, nextPath: "/auth/check-email" });
  },
);

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------
authRoutes.post(
  "/login",
  // Only the network bucket can be applied as middleware: the per-account
  // bucket needs the email, which is not known until the body is validated, so
  // it is consumed inside the handler via `loginCooldown` / `consume`.
  rateLimit({ bucket: "auth.login.ip", subject: bySubjectIp }),
  validateBody(loginSchema),
  async (c) => {
    const input = body<LoginInput>(c);
    const { auth, db, limiter, turnstile, audit, logger } = c.get("services");
    const ipHash = c.get("ipHash");

    // --- Progressive cooldown, per account ---------------------------------
    // Not a lockout: the wait grows with consecutive failures, caps at 15
    // minutes, and decays on its own. A user who eventually remembers their
    // password is never permanently locked out.
    const { waitSeconds, failures } = await limiter.loginCooldown(input.email);
    if (waitSeconds > 0) {
      await audit.security({
        type: "rate_limit_exceeded",
        severity: "warning",
        targetEmail: input.email,
        ipHash,
        requestId: c.get("requestId"),
        metadata: { flow: "login_cooldown", failures, waitSeconds },
      });
      throw apiError("RATE_LIMITED", { retryAfter: waitSeconds });
    }

    // --- Turnstile after repeated failures ---------------------------------
    // The first honest attempt stays frictionless; a script hits a challenge.
    if (loginNeedsChallenge(failures, false)) {
      const verified = await turnstile.verify(input.turnstileToken, c.get("clientIp"));
      if (!verified.success) {
        throw apiError("TURNSTILE_FAILED", {
          details: { challengeRequired: true },
        });
      }
    }

    try {
      const result = await auth.api.signInEmail({
        body: { email: input.email, password: input.password, rememberMe: input.rememberMe },
        headers: c.req.raw.headers,
        asResponse: true,
      });

      if (!result.ok) throw new Error("sign-in rejected");

      // Better Auth's 2FA plugin answers a 2FA-enabled account with a challenge
      // instead of a session. Pass that through so the client can prompt.
      const payload = (await result
        .clone()
        .json()
        .catch(() => ({}))) as {
        twoFactorRedirect?: boolean;
        twoFactorMethods?: string[];
      };

      if (payload.twoFactorRedirect) {
        // Forward Better Auth's own Set-Cookie headers (the 2FA challenge
        // cookie) untouched — re-issuing them by hand would risk dropping an
        // attribute.
        const challenge = ok(c, {
          twoFactorRequired: true,
          methods: payload.twoFactorMethods ?? ["totp"],
        });
        copySetCookies(result, challenge);
        return challenge;
      }

      // --- Success -------------------------------------------------------
      await limiter.reset("auth.login.account", `email:${input.email}`);

      const account = await db.query.user.findFirst({
        where: eq(userTable.normalizedEmail, input.email),
      });

      if (account) {
        await db
          .update(userTable)
          .set({ lastLoginAt: new Date(), lastLoginIpHash: ipHash })
          .where(eq(userTable.id, account.id));

        await audit.security({
          type: account.role === "user" ? "login_succeeded" : "admin_login",
          severity: account.role === "user" ? "info" : "warning",
          userId: account.id,
          ipHash,
          requestId: c.get("requestId"),
          userAgent: c.req.header("user-agent") ?? null,
        });
      }

      const response = ok(c, {
        success: true,
        redirectTo: safeRedirectPath(new URL(c.req.url).searchParams.get("next")),
      });
      copySetCookies(result, response);
      return response;
    } catch {
      // Count the failure against BOTH the account and the network.
      await limiter.consume("auth.login.account", `email:${input.email}`);

      await audit.security({
        type: "login_failed",
        severity: failures >= 5 ? "warning" : "info",
        targetEmail: input.email,
        ipHash,
        requestId: c.get("requestId"),
        userAgent: c.req.header("user-agent") ?? null,
        metadata: { failures: failures + 1 },
      });

      logger.info("login_failed", { failures: failures + 1 });

      // ONE message for every cause: unknown address, wrong password,
      // unverified account, suspended account. The caller learns nothing.
      throw apiError("INVALID_CREDENTIALS", {
        details: loginNeedsChallenge(failures + 1, false) ? { challengeRequired: true } : undefined,
      });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /auth/logout  and  /auth/logout-all
// ---------------------------------------------------------------------------
authRoutes.post("/logout", async (c) => {
  const { auth } = c.get("services");
  const result = await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true });
  const response = ok(c, { success: true });
  copySetCookies(result, response);
  return response;
});

authRoutes.post("/logout-all", requireAuth, async (c) => {
  const principal = c.get("principal")!;
  const { auth, audit } = c.get("services");

  const result = await auth.api.revokeSessions({
    headers: c.req.raw.headers,
    asResponse: true,
  });

  await audit.recordStandalone({
    action: "user.sessions.revoke_all",
    actorType: "user",
    actorId: principal.userId,
    targetType: "user",
    targetId: principal.userId,
    requestId: c.get("requestId"),
    ipHash: c.get("ipHash"),
  });
  await audit.security({
    type: "sessions_revoked_all",
    userId: principal.userId,
    ipHash: c.get("ipHash"),
    requestId: c.get("requestId"),
  });

  const response = ok(c, { success: true });
  copySetCookies(result, response);
  return response;
});

// ---------------------------------------------------------------------------
// POST /auth/verify-email
// ---------------------------------------------------------------------------
authRoutes.post("/verify-email", validateBody(verifyEmailSchema), async (c) => {
  const { token } = body<{ token: string }>(c);
  const { auth, db, mailer, config, audit, credits } = c.get("services");

  const result = await auth.api
    .verifyEmail({ query: { token }, headers: c.req.raw.headers, asResponse: true })
    .catch(() => null);

  if (!result || !result.ok) {
    // Deliberately vague: a token being invalid vs. expired vs. already used
    // is not information a caller needs, and distinguishing them would help an
    // attacker probe token validity.
    throw apiError("VALIDATION_ERROR", {
      details: { token: "This link is invalid or has expired. Request a new one." },
    });
  }

  /**
   * Better Auth verifies email with a STATELESS signed token — there is no row
   * to consume, so `verifyEmail` returns `{ status: true, user: null }` and a
   * still-valid link can be presented again until it expires. That is
   * idempotent rather than dangerous (re-verifying an already-verified address
   * changes nothing and grants nothing), but it does mean the response carries
   * no user, so the welcome email and the audit event are emitted from Better
   * Auth's `afterEmailVerification` hook instead of from here.
   */
  const payload = (await result
    .clone()
    .json()
    .catch(() => ({}))) as { status?: boolean };
  if (payload.status !== true) {
    throw apiError("VALIDATION_ERROR", {
      details: { token: "This link is invalid or has expired. Request a new one." },
    });
  }

  void db;
  void credits;
  void mailer;
  void config;
  void audit;

  const response = ok(c, { success: true, redirectTo: "/app" });
  copySetCookies(result, response);
  return response;
});

/**
 * The request headers with any session cookie removed.
 *
 * Both endpoints below act on an address supplied in the BODY, for someone who
 * by definition cannot sign in — they have not confirmed their address, or they
 * have forgotten their password. The browser may nonetheless still hold a
 * session for a DIFFERENT account: a shared machine, or a developer's own test
 * login.
 *
 * `sendVerificationEmail` refuses outright in that situation, raising
 * "Email mismatch". Because the response here is deliberately neutral, the
 * refusal was invisible: the caller was told the mail was on its way, the
 * per-account rate-limit budget was spent, and nothing was sent.
 *
 * `requestPasswordReset` does not currently apply the same check. It is given
 * the same treatment anyway — the two endpoints have identical requirements,
 * and relying on one library version's leniency is how the first bug got in.
 *
 * Dropping the cookie removes nothing that was protecting anything: the
 * address comes from the body, both endpoints are rate-limited per account and
 * per IP, forgot-password additionally requires Turnstile, and the response is
 * identical whether or not the account exists.
 */
function withoutSession(headers: Headers): Headers {
  const copy = new Headers(headers);
  copy.delete("cookie");
  return copy;
}

// ---------------------------------------------------------------------------
// POST /auth/resend-verification
// ---------------------------------------------------------------------------
authRoutes.post(
  "/resend-verification",
  validateBody(resendVerificationSchema),
  rateLimit({ bucket: "auth.forgot_password.ip", subject: bySubjectIp }),
  async (c) => {
    const { email } = body<{ email: string }>(c);
    const { auth, db, limiter } = c.get("services");

    const account = await db.query.user.findFirst({
      where: eq(userTable.normalizedEmail, email),
    });

    // Only do work for a real, unverified account — but return the same
    // response regardless, so the endpoint cannot be used to test addresses.
    if (account && !account.emailVerified) {
      const allowed = await limiter.consume(
        "auth.resend_verification.account",
        `user:${account.id}`,
      );
      if (allowed.allowed) {
        // Swallowing this silently would be the worst of both worlds: the
        // caller is told the mail is on its way (deliberately — the response
        // must not reveal whether the account exists) while nobody learns that
        // it never left. The neutral response stays; the failure gets logged.
        await auth.api
          .sendVerificationEmail({ body: { email }, headers: withoutSession(c.req.raw.headers) })
          .catch((error: unknown) => {
            c.get("logger").error("resend_verification_failed", {
              userId: account.id,
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          });
      }
    }

    return ok(c, NEUTRAL_EMAIL_RESPONSE);
  },
);

// ---------------------------------------------------------------------------
// POST /auth/forgot-password
// ---------------------------------------------------------------------------
authRoutes.post(
  "/forgot-password",
  validateBody(forgotPasswordSchema),
  rateLimit({ bucket: "auth.forgot_password.ip", subject: bySubjectIp }),
  async (c) => {
    const { email, turnstileToken } = body<{ email: string; turnstileToken?: string }>(c);
    const { auth, db, limiter, turnstile, audit } = c.get("services");

    const verified = await turnstile.verify(turnstileToken, c.get("clientIp"));
    if (!verified.success) throw apiError("TURNSTILE_FAILED");

    // Per-email limit, applied whether or not the account exists so that a
    // rate-limit response cannot itself reveal existence.
    const perEmail = await limiter.consume("auth.forgot_password.email", `email:${email}`);

    if (perEmail.allowed) {
      /**
       * Invalidate any reset token this account already has, BEFORE issuing a
       * new one.
       *
       * Better Auth does not do this on its own — a second forgot-password
       * request leaves the first token live until it expires. The brief
       * requires that issuing a new token invalidates existing ones, and the
       * reason is concrete: a user who requests a reset because they suspect
       * compromise must not leave a working token in an attacker's inbox.
       *
       * Layout note: Better Auth stores these as
       * `identifier = 'reset-password:<token>'` with `value = '<userId>'`,
       * so the user is matched on `value`.
       */
      const account = await db.query.user.findFirst({
        where: eq(userTable.normalizedEmail, email),
      });
      if (account) {
        await db.execute(sql`
          DELETE FROM verification_tokens
          WHERE identifier LIKE 'reset-password:%' AND value = ${account.id}
        `);
      }

      // Better Auth's reset token is single-use: redeeming it deletes the row.
      await auth.api
        .requestPasswordReset({
          body: { email, redirectTo: "/auth/reset-password" },
          headers: withoutSession(c.req.raw.headers),
        })
        .catch((error: unknown) => {
          // Neutral to the caller, loud to the operator. A reset that never
          // leaves is indistinguishable from one that did, from the outside.
          c.get("logger").error("password_reset_send_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
    }

    await audit.security({
      type: "password_reset_requested",
      targetEmail: email,
      ipHash: c.get("ipHash"),
      requestId: c.get("requestId"),
    });

    // Always the same answer.
    return ok(c, NEUTRAL_EMAIL_RESPONSE);
  },
);

// ---------------------------------------------------------------------------
// POST /auth/reset-password
// ---------------------------------------------------------------------------
authRoutes.post("/reset-password", validateBody(resetPasswordSchema), async (c) => {
  const { token, password } = body<{ token: string; password: string }>(c);
  const { auth, audit } = c.get("services");

  const result = await auth.api
    .resetPassword({ body: { token, newPassword: password }, headers: c.req.raw.headers })
    .catch(() => null);

  if (!result) {
    throw apiError("VALIDATION_ERROR", {
      details: { token: "This reset link is invalid or has expired. Request a new one." },
    });
  }

  await audit.security({
    type: "password_reset_completed",
    severity: "warning",
    ipHash: c.get("ipHash"),
    requestId: c.get("requestId"),
  });

  // Better Auth revokes every session on reset (revokeSessionsOnPasswordReset)
  // and `onPasswordReset` sends the notification email.
  return ok(c, { success: true, redirectTo: "/auth/login" });
});

// ---------------------------------------------------------------------------
// POST /auth/change-password
// ---------------------------------------------------------------------------
authRoutes.post("/change-password", requireAuth, validateBody(changePasswordSchema), async (c) => {
  const principal = c.get("principal")!;
  const { auth, mailer, config, audit } = c.get("services");
  const input = body<{
    currentPassword: string;
    newPassword: string;
    revokeOtherSessions: boolean;
  }>(c);

  const result = await auth.api
    .changePassword({
      body: {
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        // Rotating other sessions is the security-relevant half of a password
        // change: if someone else had one, this is what evicts them.
        revokeOtherSessions: input.revokeOtherSessions,
      },
      headers: c.req.raw.headers,
      asResponse: true,
    })
    .catch(() => null);

  if (!result || !result.ok) {
    throw apiError("INVALID_CREDENTIALS", {
      details: { currentPassword: "That password doesn't match your current one." },
    });
  }

  await mailer.send({
    to: principal.email,
    template: "password_changed",
    userId: principal.userId,
    force: true,
    rendered: templates.passwordChanged(
      { appUrl: config.APP_URL, supportEmail: config.SUPPORT_EMAIL },
      { name: principal.name, when: new Date().toUTCString() },
    ),
  });

  await audit.recordStandalone({
    action: "user.password.change",
    actorType: "user",
    actorId: principal.userId,
    targetType: "user",
    targetId: principal.userId,
    requestId: c.get("requestId"),
    ipHash: c.get("ipHash"),
  });
  await audit.security({
    type: "password_changed",
    severity: "warning",
    userId: principal.userId,
    ipHash: c.get("ipHash"),
    requestId: c.get("requestId"),
  });

  const response = ok(c, { success: true });
  copySetCookies(result, response);
  return response;
});

// ---------------------------------------------------------------------------
// POST /auth/two-factor/verify  and  /auth/two-factor/verify-backup
// ---------------------------------------------------------------------------
/**
 * Thin, JSON-only wrappers over Better Auth's TOTP endpoints.
 *
 * They exist so the browser never has to send a native form POST at
 * `/api/auth/*`: a form can only produce urlencoded or multipart bodies, which
 * `originGuard` refuses precisely because that is the shape a cross-origin CSRF
 * form takes. Routing 2FA through here keeps every state-changing request
 * JSON-only, and adds the security-event recording the library has no reason to
 * know about.
 */
for (const [path, apiMethod, eventOnFailure] of [
  ["/two-factor/verify", "verifyTOTP", "admin_2fa_failed"],
  ["/two-factor/verify-backup", "verifyBackupCode", "admin_2fa_failed"],
] as const) {
  authRoutes.post(
    path,
    validateBody(twoFactorSchema),
    rateLimit({ bucket: "auth.login.ip", subject: bySubjectIp }),
    async (c) => {
      const { auth, audit } = c.get("services");
      const input = body<{ code: string; trustDevice?: boolean }>(c);

      const result = await auth.api[apiMethod]({
        body: { code: input.code, trustDevice: input.trustDevice ?? false },
        headers: c.req.raw.headers,
        asResponse: true,
      }).catch(() => null);

      if (!result || !result.ok) {
        await audit.security({
          type: eventOnFailure,
          severity: "warning",
          ipHash: c.get("ipHash"),
          requestId: c.get("requestId"),
          metadata: { method: path.endsWith("backup") ? "backup_code" : "totp" },
        });
        // One message for a wrong code and an expired one alike.
        throw apiError("INVALID_CREDENTIALS", {
          details: { code: "That code is not valid." },
        });
      }

      const response = ok(c, { success: true });
      copySetCookies(result, response);
      return response;
    },
  );
}

/**
 * Move Better Auth's Set-Cookie headers onto our enveloped response.
 *
 * Copied verbatim rather than reconstructed: the library sets the attributes
 * (including the `__Host-` prefix and SameSite) and re-building them by hand
 * would risk silently dropping one.
 */
function copySetCookies(from: Response, to: Response): void {
  const cookies = from.headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) to.headers.append("set-cookie", cookie);
}

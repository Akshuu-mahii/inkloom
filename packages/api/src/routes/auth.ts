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
import { Hono, type Context } from "hono";
import { eq, sql } from "drizzle-orm";
import {
  account as accountTable,
  newId,
  notificationPreference,
  user as userTable,
  userConsent,
} from "@inkloom/db";
import { loginNeedsChallenge, TWO_FACTOR_LOCK_SECONDS } from "@inkloom/core/rate-limit";
import { safeRedirectPath } from "@inkloom/core/security";
import { isAdminRole, type Role } from "@inkloom/core/rbac";
import { AppError } from "@inkloom/core/errors";
import { templates } from "@inkloom/email";
import type { Env } from "../context";
import { apiError, ok } from "../lib/response";
import { defer } from "../lib/defer";
import { body, validateBody } from "../middleware/validate";
import { bySubjectIp, rateLimit } from "../middleware/rate-limit";
import { requireAuth } from "../middleware/auth";
import {
  changePasswordSchema,
  twoFactorPasswordSchema,
  twoFactorSchema,
  forgotPasswordSchema,
  loginSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  setPasswordSchema,
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

/**
 * What happens when someone signs up with an address that already has an account.
 *
 * This DELIBERATELY reveals that the address is registered, which is a reversal
 * of how this file treats every other flow. The reasoning:
 *
 * A signup form cannot really hide it. The address either becomes an account or
 * it does not, and the person finds out either way the moment they try to use
 * it. What a neutral response buys is not secrecy — it is a person staring at
 * "check your email" for a message that is never coming, concluding the product
 * is broken. GitHub, Stripe, Slack and Google all say plainly that the address
 * is taken, for exactly that reason.
 *
 * Enumeration protection still applies in full to LOGIN and PASSWORD RESET,
 * where it actually holds: there, an attacker learns nothing about which
 * addresses exist, and the legitimate user loses nothing because the mail they
 * are waiting for does arrive.
 *
 * The two states are answered differently because they need different things:
 *
 *   - VERIFIED: the account is usable. Say so and point at sign-in. No email —
 *     a "someone tried to sign up as you" notice for a routine duplicate is
 *     noise, and trains people to ignore security mail that matters.
 *   - UNVERIFIED: registered but never confirmed, so sign-in will refuse them.
 *     Telling them to sign in would be a dead end. Resend the confirmation and
 *     say so.
 *
 * Either way the attempt is recorded for operators.
 */
async function refuseDuplicateSignup(c: Context<Env>, email: string): Promise<Response> {
  const { db, auth, audit, limiter, logger } = c.get("services");

  logger.info("signup_duplicate", {});
  await defer(
    c,
    audit.security({
      type: "login_failed",
      severity: "info",
      targetEmail: email,
      ipHash: c.get("ipHash"),
      requestId: c.get("requestId"),
      metadata: { flow: "signup_duplicate" },
    }),
    "signup_duplicate",
  );

  const account = await db.query.user.findFirst({
    where: eq(userTable.normalizedEmail, email.trim().toLowerCase()),
  });

  if (account && !account.emailVerified) {
    /*
     * THE SAME PER-ACCOUNT BUDGET THE RESEND ENDPOINT SPENDS.
     *
     * This path re-sends a verification email, and it used to do so with no
     * per-account limit at all — only the signup endpoint's 5-per-hour per
     * NETWORK cap stood in the way. So anyone could point repeated signups at
     * a stranger's unverified address and keep mailing them, from as many
     * networks as they had, while `/auth/resend-verification` refused the
     * fourth attempt in an hour from anywhere. Two doors to one mailbox, one
     * of them unlocked.
     *
     * Sharing `auth.resend_verification.account` closes it properly: the budget
     * belongs to the ACCOUNT, so it does not matter which door the request
     * came through.
     *
     * The response is unchanged either way. It must not reveal whether the
     * mail was actually sent, for the same reason it does not reveal whether
     * the address exists.
     */
    const allowed = await limiter.consume("auth.resend_verification.account", `user:${account.id}`);

    if (allowed.allowed) {
      await auth.api
        .sendVerificationEmail({ body: { email: account.email } })
        .catch((error: unknown) => logger.warn("duplicate_signup_resend_failed", { error }));
    } else {
      logger.info("duplicate_signup_resend_throttled", { userId: account.id });
    }

    return ok(c, {
      success: true,
      message:
        "That address is already registered but not confirmed yet. We have sent the confirmation link again.",
      nextPath: `/auth/check-email?to=${encodeURIComponent(account.email)}`,
    });
  }

  throw apiError("CONFLICT", {
    details: {
      email: "An account with this email already exists. Sign in instead.",
    },
  });
}

// ---------------------------------------------------------------------------
// POST /auth/signup
// ---------------------------------------------------------------------------
authRoutes.post(
  "/signup",
  rateLimit({ bucket: "auth.signup.ip", subject: bySubjectIp }),
  validateBody(signupSchema),
  async (c) => {
    const input = body<SignupInput>(c);
    const { auth, db, config, settings, turnstile, audit } = c.get("services");

    // Operator kill switch, checked server-side on every attempt.
    if (!(await settings.isEnabled("signup_enabled"))) {
      throw apiError("FEATURE_DISABLED", {
        details: { reason: "New registrations are paused right now." },
      });
    }

    // Turnstile is always required on signup, per the brief.
    const verified = await turnstile.verify(input.turnstileToken, c.get("clientIp"));
    if (!verified.success) {
      await defer(
        c,
        audit.security({
          type: "turnstile_failed",
          severity: "warning",
          targetEmail: input.email,
          ipHash: c.get("ipHash"),
          requestId: c.get("requestId"),
          metadata: { flow: "signup", errorCodes: verified.errorCodes },
        }),
        "turnstile_failed",
      );
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

      if (!persisted) return await refuseDuplicateSignup(c, input.email);
    } catch (error) {
      /*
       * Better Auth throws here for an already-registered address — and also for
       * anything else it refuses. `refuseDuplicateSignup` throws CONFLICT, so it
       * must not be swallowed by this same catch on its way out.
       */
      if (error instanceof AppError) throw error;
      return await refuseDuplicateSignup(c, input.email);
    }

    if (createdUserId) {
      // Record consent as an auditable, timestamped fact rather than a boolean
      // on the user row: "what did they agree to, and when" must be answerable
      // for any point in time.
      //
      // One statement, not three. Written as a loop of separate inserts it cost
      // three round trips of the twenty a signup takes, for three rows that are
      // always written together and are meaningless apart — if the privacy
      // consent were to fail after the terms consent committed, the record would
      // claim the person accepted one and not the other. A single multi-row
      // insert is both faster and atomic.
      const consentedAt = new Date();
      await db.insert(userConsent).values(
        (
          [
            { type: "terms", granted: true },
            { type: "privacy", granted: true },
            { type: "marketing_email", granted: input.marketingOptIn },
          ] as const
        ).map((consent) => ({
          id: newId("cns"),
          userId: createdUserId,
          type: consent.type,
          granted: consent.granted,
          documentVersion: "2026-09-01",
          source: "signup",
          ipHash: c.get("ipHash"),
          createdAt: consentedAt,
        })),
      );

      /*
       * Act on the marketing consent, don't just file it.
       *
       * Better Auth's `user.create.after` hook inserts the preferences row with
       * schema defaults, and `marketing_email` defaults to false. Nothing then
       * carried the answer from the signup form onto it — so someone who ticked
       * the box got a consent record saying "granted" and a preferences row
       * saying "off", and the mailer gates on the preferences row. The opt-in
       * did nothing.
       *
       * It failed in the safe direction, which is why it was invisible: no
       * unwanted mail, just a checkbox that quietly meant nothing and two
       * records of the same decision that disagreed with each other.
       *
       * Written unconditionally rather than only when true, so the preferences
       * row always states what the person actually chose.
       */
      await db
        .update(notificationPreference)
        .set({ marketingEmail: input.marketingOptIn, updatedAt: new Date() })
        .where(eq(notificationPreference.userId, createdUserId));

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
  /*
   * NEITHER login bucket is middleware, and that is the whole point.
   *
   * `rateLimit()` consumes on the way in, before the handler knows whether the
   * attempt succeeded. `auth.login.ip` is declared `countFailuresOnly`, and the
   * limiter's own note says why that matters: "a consume on the way in would
   * charge honest successes too and lock out a user who has done nothing
   * wrong." As middleware it did exactly that.
   *
   * The effect was a network budget of 100 SUCCESSFUL sign-ins per fifteen
   * minutes per IP — on a policy whose comment reads "deliberately generous:
   * one shared campus NAT must not lock out everyone". Behind carrier-grade NAT
   * that is a few hundred ordinary users, all of them correct, all refused. A
   * load test found it: every login past the hundredth came back 429 while the
   * server recorded 18ms means and no errors, because it was measuring the
   * limiter rather than the application.
   *
   * So the budget is CHECKED here and CHARGED only in the catch below, which is
   * what the failure branch already claimed to do.
   */
  validateBody(loginSchema),
  async (c) => {
    const input = body<LoginInput>(c);
    const { auth, db, limiter, turnstile, audit, logger } = c.get("services");
    const ipHash = c.get("ipHash");
    const ipSubject = bySubjectIp(c);

    // Checked, not charged. See the note on the route above.
    if (ipSubject && !(await limiter.within("auth.login.ip", ipSubject))) {
      await defer(
        c,
        audit.security({
          type: "rate_limit_exceeded",
          severity: "warning",
          ipHash,
          requestId: c.get("requestId"),
          metadata: { bucket: "auth.login.ip", path: "/auth/login" },
        }),
        "rate_limit_exceeded",
      );
      throw apiError("RATE_LIMITED");
    }

    /*
     * --- Staff accounts get a tighter budget -------------------------------
     *
     * `admin.login.account` allows 5 failures per 15 minutes against a staff
     * address, where an ordinary account gets 10. Staff credentials are the
     * highest-value target on the platform, and a stolen one reaches the
     * console rather than a single user's dashboard.
     *
     * The trade-off, stated plainly because it cuts against the enumeration
     * rule at the top of this file: an attacker willing to spend six failed
     * attempts on one address can tell a staff account from an ordinary one by
     * which threshold it trips. That is a real leak, and it is accepted here
     * for two reasons — the sixth attempt costs a Turnstile solve (the
     * challenge kicks in at three), and every one of those attempts writes a
     * security event, so buying the answer is neither cheap nor quiet. Both
     * budgets return the same RATE_LIMITED response, so only the count differs.
     *
     * If that trade ever looks wrong, deleting this block restores the uniform
     * behaviour; nothing else depends on it.
     */
    const staffAccount = await db.query.user.findFirst({
      columns: { role: true },
      where: eq(userTable.normalizedEmail, input.email),
    });
    const isStaff = staffAccount ? isAdminRole(staffAccount.role as Role) : false;

    if (isStaff && !(await limiter.within("admin.login.account", `email:${input.email}`))) {
      await defer(
        c,
        audit.security({
          type: "rate_limit_exceeded",
          severity: "critical",
          targetEmail: input.email,
          ipHash,
          requestId: c.get("requestId"),
          metadata: { bucket: "admin.login.account", flow: "admin_login_throttled" },
        }),
        "rate_limit_exceeded",
      );
      throw apiError("RATE_LIMITED", { retryAfter: 900 });
    }

    // --- Progressive cooldown, per account ---------------------------------
    // Not a lockout: the wait grows with consecutive failures, caps at 15
    // minutes, and decays on its own. A user who eventually remembers their
    // password is never permanently locked out.
    const { waitSeconds, failures } = await limiter.loginCooldown(input.email);
    if (waitSeconds > 0) {
      await defer(
        c,
        audit.security({
          type: "rate_limit_exceeded",
          severity: "warning",
          targetEmail: input.email,
          ipHash,
          requestId: c.get("requestId"),
          metadata: { flow: "login_cooldown", failures, waitSeconds },
        }),
        "rate_limit_exceeded",
      );
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
      if (isStaff) await limiter.reset("admin.login.account", `email:${input.email}`);

      const account = await db.query.user.findFirst({
        where: eq(userTable.normalizedEmail, input.email),
      });

      if (account) {
        await db
          .update(userTable)
          .set({ lastLoginAt: new Date(), lastLoginIpHash: ipHash })
          .where(eq(userTable.id, account.id));

        await defer(
          c,
          audit.security({
            type: account.role === "user" ? "login_succeeded" : "admin_login",
            severity: account.role === "user" ? "info" : "warning",
            userId: account.id,
            ipHash,
            requestId: c.get("requestId"),
            userAgent: c.req.header("user-agent") ?? null,
          }),
          "security_event",
        );
      }

      const response = ok(c, {
        success: true,
        redirectTo: safeRedirectPath(new URL(c.req.url).searchParams.get("next")),
      });
      copySetCookies(result, response);
      return response;
    } catch {
      // Count the failure against BOTH the account and the network. The
      // network half used to be missing here because the middleware had
      // already charged it — on every request, success or not.
      await limiter.consume("auth.login.account", `email:${input.email}`);
      if (ipSubject) await limiter.consume("auth.login.ip", ipSubject);
      // And, for staff, against the tighter staff budget as well.
      if (isStaff) await limiter.consume("admin.login.account", `email:${input.email}`);

      await defer(
        c,
        audit.security({
          type: "login_failed",
          severity: failures >= 5 ? "warning" : "info",
          targetEmail: input.email,
          ipHash,
          requestId: c.get("requestId"),
          userAgent: c.req.header("user-agent") ?? null,
          metadata: { failures: failures + 1 },
        }),
        "login_failed",
      );

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
  await defer(
    c,
    audit.security({
      type: "sessions_revoked_all",
      userId: principal.userId,
      ipHash: c.get("ipHash"),
      requestId: c.get("requestId"),
    }),
    "sessions_revoked_all",
  );

  const response = ok(c, { success: true });
  copySetCookies(result, response);
  return response;
});

// ---------------------------------------------------------------------------
// POST /auth/verify-email
// ---------------------------------------------------------------------------
authRoutes.post("/verify-email", validateBody(verifyEmailSchema), async (c) => {
  const { token } = body<{ token: string }>(c);
  const { auth, db, mailer, config, audit, credits, logger } = c.get("services");

  /*
   * Keep the reason on the server.
   *
   * The response is deliberately vague — invalid vs. expired vs. already used
   * is not something a caller needs, and distinguishing them lets an attacker
   * probe token validity. But swallowing the reason ENTIRELY left nothing to
   * debug with either: a verification that failed in production produced one
   * indistinguishable VALIDATION_ERROR whether the secret had rotated, the
   * clock had drifted, or the link really was a day old. The operator and the
   * attacker were equally in the dark, which is only half of the goal.
   */
  const result = await auth.api
    .verifyEmail({ query: { token }, headers: c.req.raw.headers, asResponse: true })
    .catch((error: unknown) => {
      logger.warn("verify_email_threw", {
        error:
          error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
      return null;
    });

  if (!result || !result.ok) {
    // The body carries Better Auth's own reason; it is logged, never returned.
    const reason = result
      ? await result
          .clone()
          .text()
          .then((t) => t.slice(0, 300))
          .catch(() => "<unreadable>")
      : "<threw>";
    logger.warn("verify_email_rejected", {
      status: result?.status ?? null,
      location: result?.headers.get("location") ?? null,
      reason,
    });

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
       * Matched on `value` ALONE, and that is load-bearing.
       *
       * Better Auth stores these as `identifier = 'reset-password:<token>'`
       * with `value = '<userId>'`. This used to filter on
       * `identifier LIKE 'reset-password:%'` as well, which was correct until
       * the identifier started being stored hashed — a hash does not begin with
       * that prefix, so the clause silently matched nothing and superseded
       * tokens stayed live. The regression test for this caught it, which is
       * the entire reason that test exists.
       *
       * Matching on `value` is sufficient and stays correct whatever the
       * identifier looks like: password reset is the only flow that writes a
       * verification row at all here, since email verification carries a signed
       * token and stores nothing.
       */
      const account = await db.query.user.findFirst({
        where: eq(userTable.normalizedEmail, email),
      });
      if (account) {
        await db.execute(sql`
          DELETE FROM verification_tokens WHERE value = ${account.id}
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

    await defer(
      c,
      audit.security({
        type: "password_reset_requested",
        targetEmail: email,
        ipHash: c.get("ipHash"),
        requestId: c.get("requestId"),
      }),
      "password_reset_requested",
    );

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

  await defer(
    c,
    audit.security({
      type: "password_reset_completed",
      severity: "warning",
      ipHash: c.get("ipHash"),
      requestId: c.get("requestId"),
    }),
    "password_reset_completed",
  );

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
  await defer(
    c,
    audit.security({
      type: "password_changed",
      severity: "warning",
      userId: principal.userId,
      ipHash: c.get("ipHash"),
      requestId: c.get("requestId"),
    }),
    "password_changed",
  );

  const response = ok(c, { success: true });
  copySetCookies(result, response);
  return response;
});

// ---------------------------------------------------------------------------
// POST /auth/set-password
// ---------------------------------------------------------------------------
/**
 * Give a password to an account that has never had one.
 *
 * Signing up through Google creates no credential row, which quietly disables
 * three things that all ask for the current password: changing the password,
 * changing the email address, and turning on two-factor. The dashboard used to
 * show all three to a Google user as forms that could only fail.
 *
 * This is the way back in. It is deliberately NOT a way to change an existing
 * password — that path requires the old one — so it refuses outright if a
 * password is already set. Otherwise anyone who got hold of a live session
 * could overwrite the password without knowing it.
 */
authRoutes.post("/set-password", requireAuth, validateBody(setPasswordSchema), async (c) => {
  const { auth, db, mailer, config, audit } = c.get("services");
  const principal = c.get("principal")!;
  const input = body<{ newPassword: string }>(c);

  const existing = await db
    .select({ password: accountTable.password })
    .from(accountTable)
    .where(eq(accountTable.userId, principal.userId));

  if (existing.some((row) => row.password !== null)) {
    throw apiError("CONFLICT", {
      details: {
        reason: "This account already has a password. Use the change-password form instead.",
      },
    });
  }

  const result = await auth.api
    .setPassword({ body: { newPassword: input.newPassword }, headers: c.req.raw.headers })
    .catch(() => null);

  if (!result) {
    throw apiError("INTERNAL_ERROR", {
      details: { reason: "Could not set the password. Try again." },
    });
  }

  /*
   * Told, but told accurately.
   *
   * This used to send the password_changed notice, which warns that a password
   * "was changed" — alarming and wrong for someone who signed up with Google
   * and has just set their first one. Nothing changed; something was added.
   */
  await mailer.send({
    to: principal.email,
    template: "password_added",
    userId: principal.userId,
    force: true,
    rendered: templates.passwordAdded(
      { appUrl: config.APP_URL, supportEmail: config.SUPPORT_EMAIL },
      { name: principal.name, when: new Date().toUTCString() },
    ),
  });

  await defer(
    c,
    audit.security({
      type: "password_changed",
      severity: "warning",
      userId: principal.userId,
      ipHash: c.get("ipHash"),
      requestId: c.get("requestId"),
      metadata: { firstPassword: true },
    }),
    "password_changed",
  );

  return ok(c, { success: true });
});

// ---------------------------------------------------------------------------
// POST /auth/two-factor/enable | /confirm | /disable
// ---------------------------------------------------------------------------
/**
 * Setting 2FA up, in the same JSON-only shape as everything else.
 *
 * These were missing, and the dashboard pointed its forms straight at
 * `/api/auth/two-factor/*` to compensate. That did not work: React Router
 * treats a `<Form action>` as a route to match, there is no route under
 * `/api/*`, and "Set up two-factor" landed on a 404. So two-factor was not
 * merely awkward to turn on — it could not be turned on at all.
 *
 * Enabling is deliberately two steps. `skipVerificationOnEnable` is false, so
 * `enable` only issues a secret and `confirm` is what actually arms it. That
 * ordering is what stops someone locking themselves out by saving a secret
 * their authenticator never actually accepted.
 */
authRoutes.post(
  "/two-factor/enable",
  requireAuth,
  validateBody(twoFactorPasswordSchema),
  async (c) => {
    const { auth, audit, db } = c.get("services");
    const principal = c.get("principal")!;
    const input = body<{ currentPassword: string }>(c);

    /*
     * Clear any abandoned enrolment before starting a new one.
     *
     * `enableTwoFactor` INSERTS a row each time it is called, and the schema
     * puts a plain (non-unique) index on user_id, so a second visit to the
     * setup form leaves two unverified rows for one user. `verifyTOTP` then
     * looks up "the" row for that user and gets an arbitrary one — usually not
     * the one whose secret is in the QR code the person just scanned — so
     * enrolment becomes permanently unverifiable, and the only feedback is
     * "that code is not valid" no matter how many correct codes are typed.
     *
     * Only UNVERIFIED rows are removed. A verified row is live 2FA, and
     * deleting it here would silently downgrade an account's security while
     * appearing to do the opposite.
     */
    await db.execute(sql`
      DELETE FROM two_factor WHERE user_id = ${principal.userId} AND verified = false
    `);

    const result = await auth.api
      .enableTwoFactor({
        body: { password: input.currentPassword, issuer: "Inkloom" },
        headers: c.req.raw.headers,
      })
      .catch(() => null);

    // Better Auth asks for the password here, so a failure is nearly always a
    // wrong one. Saying so beats a generic error on a form with one field.
    if (!result || !("totpURI" in result)) {
      throw apiError("INVALID_CREDENTIALS", {
        details: { currentPassword: "That password doesn't match your current one." },
      });
    }

    await audit.recordStandalone({
      action: "user.two_factor.setup_started",
      actorType: "user",
      actorId: principal.userId,
      targetType: "user",
      targetId: principal.userId,
      requestId: c.get("requestId"),
      ipHash: c.get("ipHash"),
    });

    /*
     * The secret and the backup codes leave the server exactly once, to the
     * person setting it up. Nothing here is stored in a log or an audit row —
     * an audit trail that contained a TOTP secret would be a way in, not a
     * record.
     */
    return ok(c, { totpURI: result.totpURI, backupCodes: result.backupCodes });
  },
);

authRoutes.post("/two-factor/confirm", requireAuth, validateBody(twoFactorSchema), async (c) => {
  const { auth, audit, logger } = c.get("services");
  const principal = c.get("principal")!;
  const input = body<{ code: string }>(c);

  const result = await auth.api
    .verifyTOTP({ body: { code: input.code }, headers: c.req.raw.headers, asResponse: true })
    .catch((error: unknown) => {
      logger.warn("two_factor_confirm_threw", {
        userId: principal.userId,
        error:
          error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
      return null;
    });

  if (!result || !result.ok) {
    /*
     * Keep the reason server-side.
     *
     * "That code is not valid" is the right answer for the user, but it was
     * also the only thing WE had: a wrong code, a skewed clock, a duplicated
     * enrolment row and a rejected session all produced one identical string.
     * The code itself is never logged — it is a live credential for ~30
     * seconds — but everything about why it was refused is.
     */
    const reason = await result
      ?.clone()
      .text()
      .then((t) => t.slice(0, 300))
      .catch(() => "<unreadable>");
    logger.warn("two_factor_confirm_rejected", {
      userId: principal.userId,
      status: result?.status ?? null,
      reason: reason ?? "<threw>",
      codeLength: input.code.length,
    });
  }

  if (!result || !result.ok) {
    await defer(
      c,
      audit.security({
        type: "admin_2fa_failed",
        severity: "warning",
        userId: principal.userId,
        ipHash: c.get("ipHash"),
        requestId: c.get("requestId"),
        metadata: { stage: "setup" },
      }),
      "security_event",
    );
    throw apiError("INVALID_CREDENTIALS", { details: { code: "That code is not valid." } });
  }

  await audit.recordStandalone({
    action: "user.two_factor.enabled",
    actorType: "user",
    actorId: principal.userId,
    targetType: "user",
    targetId: principal.userId,
    requestId: c.get("requestId"),
    ipHash: c.get("ipHash"),
  });

  const response = ok(c, { success: true });
  copySetCookies(result, response);
  return response;
});

authRoutes.post(
  "/two-factor/disable",
  requireAuth,
  validateBody(twoFactorPasswordSchema),
  async (c) => {
    const { auth, audit } = c.get("services");
    const principal = c.get("principal")!;
    const input = body<{ currentPassword: string }>(c);

    /*
     * Staff cannot switch it off.
     *
     * `requirePermission` refuses every admin request from an account without
     * 2FA, so an admin who disabled it would lock themselves out of the very
     * screens they need — and a compromised admin session could use this to
     * strip the second factor before doing anything else.
     */
    if (principal.role !== "user") {
      throw apiError("FORBIDDEN", {
        details: {
          reason:
            "Staff accounts must keep two-factor on. Ask another admin if you are locked out.",
        },
      });
    }

    const result = await auth.api
      .disableTwoFactor({
        body: { password: input.currentPassword },
        headers: c.req.raw.headers,
        asResponse: true,
      })
      .catch(() => null);

    if (!result || !result.ok) {
      throw apiError("INVALID_CREDENTIALS", {
        details: { currentPassword: "That password doesn't match your current one." },
      });
    }

    await defer(
      c,
      audit.security({
        type: "two_factor_disabled",
        severity: "warning",
        userId: principal.userId,
        ipHash: c.get("ipHash"),
        requestId: c.get("requestId"),
      }),
      "two_factor_disabled",
    );

    const response = ok(c, { success: true });
    copySetCookies(result, response);
    return response;
  },
);

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
        const refusal = await classifyTwoFactorRefusal(result);

        await defer(
          c,
          audit.security({
            // A lockout is a different event from a mistyped code: one is a
            // user fumbling, the other is the account-level brute-force budget
            // being spent. Recording both as `admin_2fa_failed` made a grinding
            // attack indistinguishable from a typo in the security trail.
            type: refusal.kind === "locked" ? "rate_limit_exceeded" : eventOnFailure,
            severity: refusal.kind === "wrong_code" ? "warning" : "critical",
            ipHash: c.get("ipHash"),
            requestId: c.get("requestId"),
            metadata: {
              method: path.endsWith("backup") ? "backup_code" : "totp",
              reason: refusal.kind,
              flow: "two_factor_verify",
            },
          }),
          "security_event",
        );

        throw refusal.error;
      }

      const response = ok(c, { success: true });
      copySetCookies(result, response);
      return response;
    },
  );
}

type TwoFactorRefusalKind = "wrong_code" | "challenge_spent" | "locked";

/**
 * Translate Better Auth's three distinct 2FA refusals into our taxonomy.
 *
 * The library already distinguishes them; this wrapper used to throw them all
 * away, answering every one with `INVALID_CREDENTIALS` and the message "Those
 * details don't match an account. Check your email and password." That was
 * wrong three times over. It names email and password to someone who just
 * typed a six-digit code; it tells a user whose challenge is spent that their
 * password is bad, when what they must do is sign in again; and it hides a
 * fifteen-minute lockout entirely, so a locked-out user sees "wrong code"
 * forever with nothing to indicate that waiting is what fixes it.
 *
 * None of this leaks anything. The enumeration rule protects the fact that an
 * address HAS an account — a caller who has already supplied the right password
 * and holds a live challenge cookie knows that. What is withheld here is still
 * everything that matters: whether the code was close, which factor is
 * enrolled, how many attempts remain.
 *
 *   401 INVALID_CODE                     -> wrong code, attempts remain
 *   400 TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE -> challenge spent, sign in again
 *   429 ACCOUNT_TEMPORARILY_LOCKED       -> account budget spent, wait it out
 *
 * Both the status and the body code are checked, so a library that changes one
 * of the two still classifies correctly, and anything unrecognised falls back
 * to the safest reading (a wrong code).
 */
async function classifyTwoFactorRefusal(
  result: Response | null,
): Promise<{ kind: TwoFactorRefusalKind; error: AppError }> {
  const status = result?.status ?? 0;
  const libraryCode = result
    ? (
        (await result
          .clone()
          .json()
          .catch(() => null)) as { code?: string } | null
      )?.code
    : null;

  if (status === 429 || libraryCode === "ACCOUNT_TEMPORARILY_LOCKED") {
    const minutes = Math.round(TWO_FACTOR_LOCK_SECONDS / 60);
    return {
      kind: "locked",
      error: new AppError(
        "RATE_LIMITED",
        `Too many incorrect codes. Try again in ${minutes} minutes.`,
        {
          retryAfter: TWO_FACTOR_LOCK_SECONDS,
          details: { code: `Locked for ${minutes} minutes after repeated failures.` },
        },
      ),
    };
  }

  if (status === 400 || libraryCode === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE") {
    return {
      kind: "challenge_spent",
      error: new AppError(
        "UNAUTHENTICATED",
        "Too many attempts on this sign-in. Please sign in again.",
        { details: { code: "This sign-in attempt has expired.", nextPath: "/auth/login" } },
      ),
    };
  }

  return {
    kind: "wrong_code",
    error: new AppError("INVALID_CREDENTIALS", "That code is not valid.", {
      details: { code: "That code is not valid." },
    }),
  };
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

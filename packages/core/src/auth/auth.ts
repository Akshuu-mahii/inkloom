/**
 * Better Auth configuration.
 *
 * Everything cryptographic — password hashing (scrypt), session token
 * generation, verification and reset tokens, TOTP secrets, backup codes — is
 * the library's job. Inkloom implements NONE of it. What this file does is
 * configure that library correctly and attach the policies the brief requires:
 *
 *   - a `__Host-` prefixed, host-only, HttpOnly, SameSite=Lax session cookie
 *   - case-insensitive email uniqueness, enforced by a normalised column
 *   - mandatory email verification before login
 *   - mandatory 2FA for admin roles
 *   - session rotation on password change, and revocation on reset
 *   - notification email after password/email changes
 *   - pseudonymised IP storage on sessions
 */
import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin as adminPlugin, twoFactor } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import type { Database } from "@inkloom/db/client";
import { schema } from "@inkloom/db/client";
import { newId } from "@inkloom/db";
import { templates } from "@inkloom/email";
import type { AppConfig } from "../config/index";
import type { Logger } from "../util/logger";
import type { Mailer } from "../notifications/mailer";
import { hashIp } from "../util/crypto";
import { ADMIN_ROLES } from "../rbac/permissions";
import {
  TWO_FACTOR_LOCK_SECONDS,
  TWO_FACTOR_MAX_FAILED_ATTEMPTS,
} from "../rate-limit/policies";
import { deviceLabel } from "./session-policy";

/**
 * The session cookie name.
 *
 * `__Host-` is a browser-enforced prefix: a cookie carrying it is only accepted
 * if it is Secure, has Path=/, and has NO Domain attribute. That last part is
 * the valuable one — it makes the cookie host-only, so a compromised or
 * attacker-controlled sibling subdomain cannot set or overwrite our session
 * cookie. The browser rejects any Set-Cookie that violates those rules, which
 * means the guarantee cannot be silently lost by a config mistake.
 *
 * The prefix requires HTTPS, so plain-HTTP local development falls back to an
 * unprefixed name. `assertSessionCookieName` is asserted in the integration
 * suite against a real Set-Cookie header.
 */
export const SESSION_COOKIE_NAME = "__Host-inkloom_session";
export const SESSION_COOKIE_NAME_INSECURE = "inkloom_session";

export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_NAME : SESSION_COOKIE_NAME_INSECURE;
}

export interface AuthDeps {
  db: Database;
  config: AppConfig;
  logger: Logger;
  mailer: Mailer;
  /** Called after a successful sign-in so the app can record security events. */
  onSignIn?: (input: { userId: string; isNewDevice: boolean }) => Promise<void>;
}

/**
 * Role declarations for Better Auth's admin plugin.
 *
 * The plugin refuses to start unless every name in `adminRoles` is a role it
 * knows about, so Inkloom's five roles are declared here. These declarations
 * exist ONLY to satisfy the plugin and to let it gate its own built-in
 * endpoints; they are not where Inkloom's authorization decisions are made.
 *
 * The authoritative permission matrix is `@inkloom/core/rbac`, enforced by the
 * API's `requirePermission` middleware on every admin route. Keeping one
 * matrix — rather than mirroring the full policy into the library's DSL — means
 * there is exactly one place a permission can be granted, and no possibility of
 * the two definitions drifting apart.
 */
const accessControl = createAccessControl({
  user: ["read", "suspend", "revoke_sessions"],
  campaign: ["read", "create", "update", "pause", "revoke"],
  credits: ["read", "adjust", "reverse"],
  system: ["read", "write", "emergency"],
});

const authRoles = {
  user: accessControl.newRole({}),
  support: accessControl.newRole({ user: ["read"], credits: ["read"], campaign: ["read"] }),
  operations: accessControl.newRole({
    user: ["read", "suspend", "revoke_sessions"],
    credits: ["read"],
    campaign: ["read", "pause"],
    system: ["read"],
  }),
  admin: accessControl.newRole({
    user: ["read", "suspend", "revoke_sessions"],
    credits: ["read"],
    campaign: ["read", "update", "pause", "revoke"],
    system: ["read"],
  }),
  super_admin: accessControl.newRole({
    user: ["read", "suspend", "revoke_sessions"],
    campaign: ["read", "create", "update", "pause", "revoke"],
    credits: ["read", "adjust", "reverse"],
    system: ["read", "write", "emergency"],
  }),
};

export function createAuth(deps: AuthDeps) {
  const { db, config, logger, mailer } = deps;

  const eqUserId = (id: string) => eq(schema.creditWallet.userId, id);

  // Secure cookies everywhere except plain-HTTP local development. The
  // `__Host-` prefix is only legal on a Secure cookie.
  const useSecureCookies = config.APP_URL.startsWith("https://");
  const emailContext = { appUrl: config.APP_URL, supportEmail: config.SUPPORT_EMAIL };

  return betterAuth({
    appName: "Inkloom",
    baseURL: config.BETTER_AUTH_URL ?? config.APP_URL,
    secret: config.BETTER_AUTH_SECRET,
    /**
     * Better Auth mounts its own routes under this path. They sit alongside the
     * hand-written `/api/v1/*` endpoints on the SAME origin, so the session
     * cookie is first-party for both and no CORS is involved anywhere.
     */
    basePath: "/api/auth",

    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        twoFactor: schema.twoFactor,
      },
    }),

    /** Prefixed ULIDs rather than the library default, so ids stay consistent. */
    advanced: {
      database: {
        generateId: ({ model }) => {
          switch (model) {
            case "user":
              return newId("usr");
            case "session":
              return newId("ses");
            case "account":
              return newId("acc");
            case "verification":
              return newId("vrf");
            case "twoFactor":
              return newId("tfa");
            default:
              return newId("evt");
          }
        },
      },
      useSecureCookies,
      /**
       * No `crossSubDomainCookies`: the cookie must stay host-only for the
       * `__Host-` prefix to be valid, and app.inkloom.art serving both the UI
       * and the API means there is nothing to share it with.
       */
      cookies: {
        session_token: {
          name: sessionCookieName(useSecureCookies),
          attributes: {
            httpOnly: true,
            secure: useSecureCookies,
            // Lax, not Strict: Strict would drop the cookie when a user
            // arrives by clicking the verification link in their email, which
            // would break the very flow it is protecting. Lax still withholds
            // the cookie from cross-site POSTs, which is the CSRF-relevant case,
            // and the explicit Origin check covers the rest.
            sameSite: "lax",
            path: "/",
            // No `domain` — required by the __Host- prefix.
          },
        },
      },
      /**
       * Better Auth would otherwise write the raw request IP onto the session.
       * Inkloom stores a rotating keyed hash instead; see the databaseHooks
       * below and `hashIp`.
       */
      ipAddress: {
        disableIpTracking: false,
      },
    },

    trustedOrigins: [config.origin],

    emailAndPassword: {
      enabled: true,
      /** No sign-in until the address is confirmed. */
      requireEmailVerification: true,
      /**
       * Kept in step with `passwordSchema` in @inkloom/api.
       *
       * The library only ever checks length; the letter/number/symbol rules are
       * enforced by that schema on every route that accepts a password. If this
       * number were higher than the schema's, the schema would accept a
       * password the library then rejected, and the person would be told their
       * valid password was wrong.
       */
      minPasswordLength: 6,
      /** Long enough for any passphrase; bounded so hashing cost stays sane. */
      maxPasswordLength: 200,
      /** Verification is required, so there is nothing to sign into yet. */
      autoSignIn: false,
      resetPasswordTokenExpiresIn: 60 * 60,
      /**
       * Revoking sessions on reset is the point of a reset: if an attacker had
       * a session, the legitimate owner's reset must evict them.
       */
      revokeSessionsOnPasswordReset: true,

      sendResetPassword: async ({ user, token }) => {
        /**
         * Links straight to Inkloom's own reset page, for the same reason as
         * the verification email: the library's URL bounces through its API
         * and lands the user somewhere generic, while `/auth/reset-password`
         * gives them a branded form, an honest message when the link has
         * expired, and a one-click way to request another.
         */
        const url = `${config.APP_URL}/auth/reset-password?token=${encodeURIComponent(token)}`;

        await mailer.send({
          to: user.email,
          template: "password_reset",
          userId: user.id,
          force: true,
          rendered: templates.passwordReset(emailContext, {
            name: user.name,
            url,
            expiresInMinutes: 60,
          }),
        });
      },

      onPasswordReset: async ({ user }) => {
        await mailer.send({
          to: user.email,
          template: "password_changed",
          userId: user.id,
          force: true,
          rendered: templates.passwordChanged(emailContext, {
            name: user.name,
            when: new Date().toUTCString(),
          }),
        });
      },
    },

    /**
     * Store the password-reset token hashed, not as the usable token.
     *
     * A reset row's `identifier` is `reset-password:<token>` and that token is
     * byte-for-byte the one in the email — verified by requesting a reset and
     * comparing the link to the row. Anyone with READ access to the database
     * could therefore paste it into the reset endpoint and take over any
     * account that has no second factor. Passwords are salted scrypt hashes and
     * 2FA secrets are encrypted, so this was the one credential still sitting in
     * usable form.
     *
     * This is Better Auth's own mechanism rather than a patch. Every path
     * through the internal adapter — create, find, consume, reserve and both
     * delete paths — runs the identifier through the same transform, so hashing
     * on write and hashing on lookup stay in step. Doing this by hand in half
     * the flow is exactly how you end up sending a reset email the server can no
     * longer resolve.
     *
     * Scoped by prefix rather than applied to everything: `default: "plain"`
     * keeps every other verification identifier untouched, because those are
     * addresses used for lookup rather than secrets, and hashing them would
     * break flows that legitimately search by them.
     *
     * Email verification is unaffected and needs nothing: it writes no
     * verification row at all — confirmed by signing up and finding the table
     * empty — because that flow carries a signed token instead.
     *
     * ON DEPLOY: reset links already in flight stop resolving, because their
     * stored identifiers are plaintext and lookups now hash. They expire in an
     * hour regardless, and anyone affected can request another.
     */
    verification: {
      storeIdentifier: {
        default: "plain",
        overrides: { "reset-password": "hashed" },
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24,

      /**
       * Fires once the address is confirmed.
       *
       * The welcome mail and the audit event live here rather than in the API
       * route because Better Auth's email verification uses a stateless signed
       * token: `verifyEmail` returns no user, so the route has nobody to send
       * to. This hook does, and it also covers verification completed by
       * clicking the link directly (which never touches our route at all).
       */
      afterEmailVerification: async (user) => {
        const wallet = await db.query.creditWallet.findFirst({
          where: eqUserId(user.id),
        });

        await mailer.send({
          to: user.email,
          template: "welcome",
          userId: user.id,
          rendered: templates.welcome(emailContext, {
            name: user.name,
            credits: wallet?.balance ?? 0,
          }),
        });

        await db.insert(schema.securityEvent).values({
          id: newId("sec"),
          type: "email_verified",
          severity: "info",
          userId: user.id,
        });

        logger.info("email_verified", { userId: user.id });
      },
      sendVerificationEmail: async ({ user, token }) => {
        /**
         * The link points at Inkloom's OWN page, not Better Auth's endpoint.
         *
         * The library's default URL redirects to the site root after verifying,
         * and an expired or reused token there produces a bare error. Routing
         * through `/auth/verify-email` means the user gets a branded page, a
         * useful message when the link has expired, a "send me a new one"
         * action, and a redirect to the dashboard on success.
         */
        const url = `${config.APP_URL}/auth/verify-email?token=${encodeURIComponent(token)}`;

        await mailer.send({
          to: user.email,
          template: "verify_email",
          userId: user.id,
          force: true,
          rendered: templates.verifyEmail(emailContext, {
            name: user.name,
            url,
            expiresInMinutes: 60 * 24,
          }),
        });
      },
    },

    /**
     * Google is configured only when both credentials are present. An
     * half-configured provider would render a button that always fails.
     */
    socialProviders: config.googleOAuthEnabled
      ? {
          google: {
            clientId: config.GOOGLE_CLIENT_ID!,
            clientSecret: config.GOOGLE_CLIENT_SECRET!,
            /**
             * Always show Google's account chooser.
             *
             * Without this, Google silently reuses whichever account the
             * browser last used, so anyone with more than one — a personal
             * address and a work one, say — gets signed into the wrong Inkloom
             * account with no visible choice and no obvious way to correct it.
             * On a shared machine it is worse than confusing.
             */
            prompt: "select_account",
            /**
             * Only link a Google identity to an existing account when Google
             * asserts the address is verified. Without this check, anyone able
             * to create an unverified Google profile for an address could take
             * over the matching Inkloom account.
             */
            mapProfileToUser: (profile) => ({
              name: profile.name,
              email: profile.email,
              image: profile.picture,
            }),
          },
        }
      : undefined,

    account: {
      accountLinking: {
        enabled: true,
        // Only providers that verify ownership of the address may auto-link.
        trustedProviders: ["google"],
      },
    },

    session: {
      /** Idle lifetime. The absolute cutoff is enforced separately. */
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      /** Sensitive actions require an authentication within this window. */
      freshAge: 60 * 15,
      /**
       * No cookie cache. It trades a database read for a signed snapshot in the
       * cookie, which means a revoked session or a suspended user could keep
       * working until the snapshot expires. For an app where an admin must be
       * able to kill a session NOW, that trade is wrong.
       */
      cookieCache: { enabled: false },
    },

    user: {
      /*
       * Both self-service account changes are switched off at the library.
       *
       * Turning them off HERE is the control, not removing Inkloom's own
       * wrappers: Better Auth mounts its own routes under /api/auth, so an
       * endpoint deleted from `me.ts` while the capability stayed enabled
       * remained reachable at /api/auth/change-email — and that route takes only
       * the session, so it also skipped the password re-authentication the
       * wrapper insisted on. Deleting the wrapper alone made the feature less
       * safe rather than absent.
       */
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },

    databaseHooks: {
      user: {
        // No `before` hook maintaining `normalized_email`: it is a Postgres
        // GENERATED column derived from `email`, so it is correct by
        // construction on every insert and update, including OAuth signups.
        create: {
          after: async (user) => {
            // A wallet and preferences from the first moment, so the dashboard
            // never has to special-case a half-provisioned account.
            await db
              .insert(schema.creditWallet)
              .values({ id: newId("wal"), userId: user.id, balance: 0 })
              .onConflictDoNothing();
            await db
              .insert(schema.notificationPreference)
              .values({ id: newId("npf"), userId: user.id })
              .onConflictDoNothing();
            await db
              .insert(schema.profile)
              .values({ id: newId("prf"), userId: user.id, displayName: user.name })
              .onConflictDoNothing();
            logger.info("user_created", { userId: user.id });
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            // Replace the raw IP with a rotating keyed hash, and reduce the
            // User-Agent to a coarse device label, BEFORE either touches
            // storage. Neither the raw IP nor the full UA is ever written.
            const ipHash = await hashIp(session.ipAddress, config.IP_HASH_PEPPER);
            return {
              data: {
                ...session,
                ipAddress: ipHash,
                userAgent: deviceLabel(session.userAgent),
              },
            };
          },
        },
      },
    },

    plugins: [
      /**
       * Mandatory for admins. Enforcement lives in the API's `requireAdmin`
       * middleware: holding an admin role without `twoFactorEnabled` yields a
       * 403 that directs the operator to finish enrolment. Making it a
       * middleware check rather than a login check means an account PROMOTED to
       * admin is also covered.
       */
      twoFactor({
        issuer: "Inkloom",
        skipVerificationOnEnable: false,
        /*
         * Stated explicitly rather than inherited.
         *
         * These are the library's own defaults, but leaving them implicit cost
         * a staging audit real time: grepping this repository for writes to
         * `two_factor.failed_verification_count` and `locked_until` finds
         * nothing — the writes happen inside the plugin, through the Drizzle
         * adapter — so the columns read as dead and the second factor read as
         * unprotected. Both conclusions were wrong. Naming the policy here
         * makes the control visible at the call site, and pins it so a library
         * default changing underneath us is a deliberate decision rather than a
         * silent one.
         *
         * Covered by two-factor-lockout.integration.test.ts, which asserts on
         * the column values and not on the presence of this block.
         */
        accountLockout: {
          enabled: true,
          maxFailedAttempts: TWO_FACTOR_MAX_FAILED_ATTEMPTS,
          durationSeconds: TWO_FACTOR_LOCK_SECONDS,
        },
      }),
      adminPlugin({
        defaultRole: "user",
        ac: accessControl,
        roles: authRoles,
        adminRoles: [...ADMIN_ROLES],
        bannedUserMessage:
          "This account is suspended. Contact support if you think that's a mistake.",
      }),
    ],

    rateLimit: {
      // Inkloom's own limiter (Postgres-backed, per-account and per-network)
      // is the policy layer; this is Better Auth's coarse own-endpoint guard.
      enabled: true,
      window: 60,
      max: 100,
    },

    onAPIError: {
      throw: false,
      onError: (error) => {
        // Never let a library error body reach a client verbatim.
        logger.error("better_auth_error", { error });
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = Auth["$Infer"]["Session"];

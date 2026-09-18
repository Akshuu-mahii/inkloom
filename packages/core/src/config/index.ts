/**
 * Runtime configuration.
 *
 * Parsed once per isolate from the environment, validated with Zod, and
 * thereafter immutable. A missing or malformed secret fails the boot rather
 * than surfacing as a confusing runtime error halfway through a request — and
 * critically, the production branch REFUSES to start on a development
 * placeholder secret, so a misconfigured deploy cannot serve traffic with a
 * known key.
 */
import { z } from "zod";

/** Values shipped in .env.example that must never reach staging or production. */
const DEV_PLACEHOLDERS = [
  "dev-only-insecure-secret-replace-me-0000000000",
  "dev-only-insecure-pepper-replace-me-000000",
  "dev-only-insecure-ip-pepper-replace-me-00",
];

const secret = (label: string, min = 32) =>
  z
    .string()
    .min(
      min,
      `${label} must be at least ${min} characters (generate with: openssl rand -base64 32)`,
    );

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : v.toLowerCase() === "true" || v === "1"));

export const envSchema = z.object({
  INKLOOM_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  APP_URL: z.url().refine((u) => !u.endsWith("/"), "APP_URL must not have a trailing slash"),

  DATABASE_URL: z.string().min(1),

  BETTER_AUTH_SECRET: secret("BETTER_AUTH_SECRET"),
  BETTER_AUTH_URL: z.url().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  ACCESS_CODE_PEPPER: secret("ACCESS_CODE_PEPPER", 24),
  IP_HASH_PEPPER: secret("IP_HASH_PEPPER", 24),

  EMAIL_TRANSPORT: z.enum(["mailpit", "resend", "console"]).default("console"),
  MAILPIT_HOST: z.string().default("127.0.0.1"),
  MAILPIT_PORT: z.coerce.number().int().positive().default(1025),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Inkloom <no-reply@mail.inkloom.art>"),
  EMAIL_REPLY_TO: z.string().default("support@inkloom.art"),
  SUPPORT_EMAIL: z.string().default("support@inkloom.art"),
  /**
   * Where support submissions are actually delivered.
   *
   * Separate from SUPPORT_EMAIL, which is printed on the contact page and in
   * every email footer. Routing complaints somewhere real should not require
   * publishing that address to the world, so this defaults to the public one
   * and can be pointed at a personal inbox without changing what visitors see.
   */
  SUPPORT_INBOX: z.string().optional(),

  TURNSTILE_SITE_KEY: z.string().default(""),
  TURNSTILE_SECRET_KEY: z.string().default(""),
  TURNSTILE_ENABLED: boolish.default(true),

  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  INKLOOM_RELEASE: z.string().default("dev"),

  /**
   * Where the admin console is mounted.
   *
   * An obscure path raises the cost of casual discovery — a scanner walking
   * /admin, /wp-admin, /administrator finds nothing. It is an obscurity layer
   * and NOTHING MORE. It leaks through Referer headers, browser history, proxy
   * and CDN logs, screenshots and shared links, and it is worth exactly zero
   * against the realistic threat, which is a compromised staff account. Every
   * control that actually matters — session, role, owner check, 2FA, recent
   * auth, rate limit, audit — is enforced server-side on every request and
   * would hold if this path were printed on the home page.
   *
   * Rotatable: change the secret, redeploy, and the old path stops resolving.
   *
   * Must start with "/" and contain one path segment of safe characters, so it
   * cannot be set to something that escapes its own prefix or collides with
   * /api, /app or /auth.
   */
  ADMIN_PATH: z
    .string()
    .default("/admin")
    .refine((v) => /^\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(v), {
      message: "ADMIN_PATH must be a single path segment such as /internal-admin-7f3a91",
    })
    .refine((v) => !["/api", "/app", "/auth", "/assets"].includes(v.toLowerCase()), {
      message: "ADMIN_PATH must not collide with a reserved prefix.",
    }),

  /**
   * The one account that owns this installation.
   *
   * A second, independent gate on top of the role check. Roles live in a table
   * an attacker with database access could edit; this lives in the deployment's
   * secrets. Both must agree before the console renders, so neither a stolen
   * session nor a rewritten role row is sufficient alone.
   *
   * Optional: unset means "role check only", which is the correct behaviour for
   * a staging environment where several people legitimately hold staff roles.
   */
  OWNER_EMAIL: z.string().optional(),

  ANALYTICS_ENABLED: boolish.default(true),
  RATE_LIMIT_ENABLED: boolish.default(true),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig extends Env {
  readonly isProduction: boolean;
  readonly isStaging: boolean;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;
  /** True only when Google OAuth is fully configured; the UI hides it otherwise. */
  readonly googleOAuthEnabled: boolean;
  /** Origin derived from APP_URL, used for strict origin checks. */
  readonly origin: string;
}

export class ConfigError extends Error {}

export function loadConfig(source: Record<string, unknown>): AppConfig {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;
  const isProduction = env.INKLOOM_ENV === "production";
  const isStaging = env.INKLOOM_ENV === "staging";

  if (isProduction || isStaging) {
    // A deploy that still carries a placeholder secret must not start.
    for (const [key, value] of Object.entries({
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
      ACCESS_CODE_PEPPER: env.ACCESS_CODE_PEPPER,
      IP_HASH_PEPPER: env.IP_HASH_PEPPER,
    })) {
      if (DEV_PLACEHOLDERS.includes(value) || value.startsWith("dev-only-")) {
        throw new ConfigError(
          `${key} is still the development placeholder. Set a real secret with ` +
            `\`wrangler secret put ${key}\` before deploying to ${env.INKLOOM_ENV}.`,
        );
      }
    }
    if (!env.APP_URL.startsWith("https://")) {
      throw new ConfigError(`APP_URL must be https:// in ${env.INKLOOM_ENV} (got ${env.APP_URL}).`);
    }
    if (env.EMAIL_TRANSPORT !== "resend") {
      throw new ConfigError(
        `EMAIL_TRANSPORT must be "resend" in ${env.INKLOOM_ENV}; Mailpit is local-only.`,
      );
    }
    if (!env.RESEND_API_KEY) {
      throw new ConfigError(`RESEND_API_KEY is required in ${env.INKLOOM_ENV}.`);
    }
    if (env.TURNSTILE_ENABLED && !env.TURNSTILE_SECRET_KEY) {
      throw new ConfigError(
        `TURNSTILE_SECRET_KEY is required in ${env.INKLOOM_ENV} while Turnstile is enabled.`,
      );
    }
    /*
     * The site key matters as much as the secret, and fails far more quietly.
     *
     * It is public — it ships in the HTML — so it lives in wrangler.jsonc rather
     * than in secrets, and that is exactly what makes it easy to lose: Wrangler
     * REPLACES the top-level `vars` block with `env.<name>.vars` instead of
     * merging, so a key set once at the top silently becomes "" in every
     * deployed environment. The widget then renders with an empty sitekey and
     * issues no token, while the server keeps demanding one, and signup, login,
     * password reset and contact all fail with nothing but "captcha failed" to
     * go on. Refusing to boot turns a day of debugging into one clear line.
     */
    if (env.TURNSTILE_ENABLED && !env.TURNSTILE_SITE_KEY) {
      throw new ConfigError(
        `TURNSTILE_SITE_KEY is required in ${env.INKLOOM_ENV} while Turnstile is enabled. ` +
          `Set it in the "${env.INKLOOM_ENV}" vars block of wrangler.jsonc — note that ` +
          `env vars REPLACE the top-level block rather than merging with it.`,
      );
    }
    if (env.TURNSTILE_SITE_KEY.startsWith("1x000000")) {
      throw new ConfigError(
        `TURNSTILE_SITE_KEY is Cloudflare's always-passing test key. Use a real key in ${env.INKLOOM_ENV}.`,
      );
    }
    // Cloudflare's public test keys always pass; shipping them is the same as
    // having no bot protection at all.
    if (env.TURNSTILE_SECRET_KEY.startsWith("1x000000")) {
      throw new ConfigError(
        `TURNSTILE_SECRET_KEY is Cloudflare's always-passing test key. Use a real key in ${env.INKLOOM_ENV}.`,
      );
    }
  }

  return Object.freeze({
    ...env,
    isProduction,
    isStaging,
    isDevelopment: env.INKLOOM_ENV === "development",
    isTest: env.INKLOOM_ENV === "test",
    googleOAuthEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    origin: new URL(env.APP_URL).origin,
  });
}

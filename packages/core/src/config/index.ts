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
  EMAIL_FROM: z.string().default("Inkloom <no-reply@mail.inkloom.com>"),
  EMAIL_REPLY_TO: z.string().default("support@inkloom.com"),
  SUPPORT_EMAIL: z.string().default("support@inkloom.com"),

  TURNSTILE_SITE_KEY: z.string().default(""),
  TURNSTILE_SECRET_KEY: z.string().default(""),
  TURNSTILE_ENABLED: boolish.default(true),

  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  INKLOOM_RELEASE: z.string().default("dev"),

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

/**
 * Feature flags and system settings.
 *
 * Every flag and setting is DECLARED here with its type, default and risk
 * level. Nothing is created ad hoc at runtime, so `/admin/settings` can render
 * a correct editor for each one and the API can validate a change before it is
 * written. An unknown key is rejected rather than stored.
 */
import { z } from "zod";

export interface FlagDefinition {
  key: string;
  description: string;
  default: boolean;
  /** Flipping this is an incident-level action: demands re-auth + confirmation. */
  highRisk: boolean;
}

/**
 * `generation_enabled` and `payments_enabled` default to FALSE and are what
 * keeps V2 surface area invisible in V1. They are declared now so the wiring
 * exists, and every V2 code path can be written behind a gate that is already
 * real — rather than shipping a half-built feature users can stumble into.
 */
export const FEATURE_FLAGS = {
  signup_enabled: {
    key: "signup_enabled",
    description: "Allow new account registration",
    default: true,
    highRisk: true,
  },
  code_redemption_enabled: {
    key: "code_redemption_enabled",
    description: "Allow access-code redemption",
    default: true,
    highRisk: true,
  },
  promotional_grants_enabled: {
    key: "promotional_grants_enabled",
    description: "Allow promotional credit grants (admin and campaign)",
    default: true,
    highRisk: true,
  },
  google_oauth_enabled: {
    key: "google_oauth_enabled",
    description: "Offer Google as a sign-in provider",
    default: false,
    highRisk: false,
  },
  early_access_open: {
    key: "early_access_open",
    description: "Accept new early-access registrations",
    default: true,
    highRisk: false,
  },
  maintenance_banner_enabled: {
    key: "maintenance_banner_enabled",
    description: "Show the maintenance banner on every page",
    default: false,
    highRisk: false,
  },
  support_form_enabled: {
    key: "support_form_enabled",
    description: "Accept new support submissions",
    default: true,
    highRisk: false,
  },
  analytics_enabled: {
    key: "analytics_enabled",
    description: "Record first-party product analytics events",
    default: true,
    highRisk: false,
  },
  // --- V2, deliberately off and unreachable in V1 -------------------------
  generation_enabled: {
    key: "generation_enabled",
    description: "V2: enable the logo-generation pipeline. Not implemented in V1.",
    default: false,
    highRisk: true,
  },
  payments_enabled: {
    key: "payments_enabled",
    description: "V2: enable checkout and credit purchase. Not implemented in V1.",
    default: false,
    highRisk: true,
  },
} as const satisfies Record<string, FlagDefinition>;

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

export const V2_FLAGS: readonly FeatureFlagKey[] = ["generation_enabled", "payments_enabled"];

// ---------------------------------------------------------------------------
// System settings
// ---------------------------------------------------------------------------

export interface SettingDefinition<T extends z.ZodTypeAny = z.ZodTypeAny> {
  key: string;
  description: string;
  schema: T;
  default: z.infer<T>;
  highRisk: boolean;
}

function setting<T extends z.ZodTypeAny>(def: SettingDefinition<T>): SettingDefinition<T> {
  return def;
}

export const SYSTEM_SETTINGS = {
  maintenance_message: setting({
    key: "maintenance_message",
    description: "Text shown in the maintenance banner when it is enabled",
    schema: z.string().max(300),
    default: "",
    highRisk: false,
  }),
  early_access_capacity: setting({
    key: "early_access_capacity",
    description: "Maximum early-access members. 0 means unlimited.",
    schema: z.number().int().min(0),
    default: 0,
    highRisk: false,
  }),
  rate_limit_overrides: setting({
    key: "rate_limit_overrides",
    description: 'Per-bucket overrides for the rate limiter, e.g. {"auth.login.ip":{"limit":50}}',
    schema: z.record(
      z.string(),
      z.object({
        limit: z.number().int().positive().optional(),
        windowSeconds: z.number().int().positive().optional(),
      }),
    ),
    default: {},
    highRisk: true,
  }),
  session_policy: setting({
    key: "session_policy",
    description: "Idle and absolute session lifetimes, in seconds, for users and admins",
    schema: z.object({
      userIdleSeconds: z.number().int().positive(),
      userAbsoluteSeconds: z.number().int().positive(),
      adminIdleSeconds: z.number().int().positive(),
      adminAbsoluteSeconds: z.number().int().positive(),
    }),
    default: {
      userIdleSeconds: 7 * 24 * 3600, //  7 days idle
      userAbsoluteSeconds: 30 * 24 * 3600, // 30 days absolute
      adminIdleSeconds: 30 * 60, // 30 minutes idle
      adminAbsoluteSeconds: 12 * 3600, // 12 hours absolute
    },
    highRisk: true,
  }),
  /**
   * Bumped to force every session to be re-validated. The emergency
   * "log everyone out" control raises this; middleware rejects any session
   * created before it.
   */
  session_epoch: setting({
    key: "session_epoch",
    description: "Sessions created before this timestamp are rejected. Used by emergency logout.",
    schema: z.object({ users: z.string(), admins: z.string() }),
    default: { users: "1970-01-01T00:00:00.000Z", admins: "1970-01-01T00:00:00.000Z" },
    highRisk: true,
  }),
  announcement: setting({
    key: "announcement",
    description: "Dashboard announcement shown to signed-in users",
    schema: z.object({
      title: z.string().max(120),
      body: z.string().max(600),
      visible: z.boolean(),
    }),
    default: { title: "", body: "", visible: false },
    highRisk: false,
  }),
} as const;

export type SystemSettingKey = keyof typeof SYSTEM_SETTINGS;

export function isFeatureFlagKey(key: string): key is FeatureFlagKey {
  return key in FEATURE_FLAGS;
}

export function isSystemSettingKey(key: string): key is SystemSettingKey {
  return key in SYSTEM_SETTINGS;
}

export type SessionPolicy = z.infer<(typeof SYSTEM_SETTINGS)["session_policy"]["schema"]>;

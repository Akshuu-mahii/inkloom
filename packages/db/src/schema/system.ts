import { boolean, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./_shared";
import { user } from "./auth";

/**
 * Feature flags — runtime kill switches.
 *
 * `generation_enabled` and `payments_enabled` are seeded to FALSE and are what
 * keeps V2 surface area invisible in V1. Nothing reads a flag from client
 * state; every gate is evaluated server-side.
 */
export const featureFlag = pgTable(
  "feature_flags",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    description: text("description").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    /**
     * True for flags whose flip is an incident-level action (emergency logout,
     * pausing signups). The API demands recent authentication plus an explicit
     * typed confirmation for these.
     */
    highRisk: boolean("high_risk").notNull().default(false),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("feature_flags_key_key").on(t.key),
    index("feature_flags_enabled_idx").on(t.enabled),
  ],
);

/**
 * Operator-tunable settings: rate limits, early-access capacity, the
 * maintenance banner. Values are JSON and validated against a per-key Zod
 * schema in @inkloom/core/settings before they are accepted.
 */
export const systemSetting = pgTable(
  "system_settings",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    description: text("description").notNull(),
    highRisk: boolean("high_risk").notNull().default(false),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("system_settings_key_key").on(t.key)],
);

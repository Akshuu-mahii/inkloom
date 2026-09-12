/**
 * Reads and writes feature flags and system settings.
 *
 * Values are cached for a few seconds. That bound matters: an emergency control
 * (pause signups, mass logout) must take effect quickly, so the TTL is short
 * enough to be operationally useful while still absorbing the per-request read
 * volume.
 *
 * THE CACHE IS MODULE-LEVEL, NOT PER INSTANCE, and that is the whole point.
 *
 * It used to be an instance field, while `buildServices` — despite a comment
 * saying "once per isolate" — runs inside the Worker's `fetch`, because it
 * takes the per-request database handle. So a fresh SettingsService, and a
 * fresh empty cache, was built and discarded on every request: the cache
 * existed, cost a Map allocation, and never once served a hit across requests.
 * Every request that read a flag, and every rate-limited request reading the
 * override setting, paid a database round trip the design had already decided
 * it should not.
 *
 * Module scope is per isolate, which is the correct lifetime: these are global
 * operator settings, identical for every caller, so there is nothing
 * user-specific to leak between requests that share one. `invalidate()` clears
 * it, which is what keeps a writer seeing their own change and what keeps tests
 * isolated from one another.
 */
import { eq } from "drizzle-orm";
import type { Database, Executor } from "@inkloom/db/client";
import { featureFlag, newId, systemSetting } from "@inkloom/db";
import { fail } from "../util/errors";
import type { Logger } from "../util/logger";
import {
  FEATURE_FLAGS,
  SYSTEM_SETTINGS,
  isFeatureFlagKey,
  isSystemSettingKey,
  type FeatureFlagKey,
  type SystemSettingKey,
} from "./registry";

const CACHE_TTL_MS = 5_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const flagCache = new Map<string, CacheEntry<boolean>>();
const settingCache = new Map<string, CacheEntry<unknown>>();

export class SettingsService {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  /** Drop caches immediately after a write, so the writer sees their own change. */
  invalidate(): void {
    flagCache.clear();
    settingCache.clear();
  }

  async isEnabled(key: FeatureFlagKey): Promise<boolean> {
    const cached = flagCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const row = await this.db.query.featureFlag.findFirst({ where: eq(featureFlag.key, key) });
    // Falling back to the declared default means a missing row degrades to the
    // SAFE value — V2 flags default to false, so an unseeded database cannot
    // accidentally expose unbuilt functionality.
    const value = row?.enabled ?? FEATURE_FLAGS[key].default;

    flagCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  async allFlags(): Promise<
    Array<{ key: string; enabled: boolean; description: string; highRisk: boolean }>
  > {
    const rows = await this.db.query.featureFlag.findMany();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return Object.values(FEATURE_FLAGS).map((def) => ({
      key: def.key,
      enabled: byKey.get(def.key)?.enabled ?? def.default,
      description: def.description,
      highRisk: def.highRisk,
    }));
  }

  async setFlag(tx: Executor, key: string, enabled: boolean, updatedBy: string): Promise<void> {
    if (!isFeatureFlagKey(key)) {
      throw fail("VALIDATION_ERROR", { details: { key: "Unknown feature flag" } });
    }
    await tx
      .insert(featureFlag)
      .values({
        id: newId("flag"),
        key,
        enabled,
        description: FEATURE_FLAGS[key].description,
        highRisk: FEATURE_FLAGS[key].highRisk,
        updatedBy,
      })
      .onConflictDoUpdate({
        target: featureFlag.key,
        set: { enabled, updatedBy, updatedAt: new Date() },
      });
    this.invalidate();
  }

  async get<K extends SystemSettingKey>(key: K): Promise<(typeof SYSTEM_SETTINGS)[K]["default"]> {
    const cached = settingCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as (typeof SYSTEM_SETTINGS)[K]["default"];
    }

    const row = await this.db.query.systemSetting.findFirst({ where: eq(systemSetting.key, key) });
    const definition = SYSTEM_SETTINGS[key];

    let value = definition.default;
    if (row) {
      const parsed = definition.schema.safeParse(row.value);
      if (parsed.success) {
        value = parsed.data;
      } else {
        // A malformed stored value must not take the site down; fall back to
        // the declared default and make the problem loud.
        this.logger.error("system_setting_invalid", { key, issues: parsed.error.issues });
      }
    }

    settingCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value as (typeof SYSTEM_SETTINGS)[K]["default"];
  }

  async set(tx: Executor, key: string, value: unknown, updatedBy: string): Promise<void> {
    if (!isSystemSettingKey(key)) {
      throw fail("VALIDATION_ERROR", { details: { key: "Unknown system setting" } });
    }
    const definition = SYSTEM_SETTINGS[key];
    const parsed = definition.schema.safeParse(value);
    if (!parsed.success) {
      throw fail("VALIDATION_ERROR", {
        details: { key, issues: parsed.error.issues.map((i) => i.message) },
      });
    }

    await tx
      .insert(systemSetting)
      .values({
        id: newId("set"),
        key,
        value: parsed.data as never,
        description: definition.description,
        highRisk: definition.highRisk,
        updatedBy,
      })
      .onConflictDoUpdate({
        target: systemSetting.key,
        set: { value: parsed.data as never, updatedBy, updatedAt: new Date() },
      });
    this.invalidate();
  }

  async allSettings(): Promise<
    Array<{ key: string; value: unknown; description: string; highRisk: boolean }>
  > {
    const rows = await this.db.query.systemSetting.findMany();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return Object.values(SYSTEM_SETTINGS).map((def) => ({
      key: def.key,
      value: byKey.get(def.key)?.value ?? def.default,
      description: def.description,
      highRisk: def.highRisk,
    }));
  }
}

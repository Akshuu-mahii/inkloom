import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, securityEventTypeEnum, tsCol } from "./_shared";
import { user } from "./auth";

/**
 * Append-only audit trail of consequential actions, especially admin ones.
 *
 * Migration 0002 revokes UPDATE and DELETE on this table from the application
 * database role. The application literally cannot rewrite history; correcting
 * a mistaken entry means appending a new one.
 */
export const auditEvent = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    /** e.g. `admin.credits.adjust`, `campaign.revoke`, `user.suspend`. */
    action: text("action").notNull(),
    /** 'user' | 'admin' | 'system' */
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    /** Snapshot of the actor's role at action time; roles change, history should not. */
    actorRole: text("actor_role"),
    /** What was acted upon, e.g. 'user', 'campaign', 'wallet'. */
    targetType: text("target_type"),
    targetId: text("target_id"),
    /** Mandatory for high-impact actions; enforced at the service layer. */
    reason: text("reason"),
    /** Before/after snapshots and any extra context. Never contains secrets. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** Correlates this event with the HTTP request that caused it. */
    requestId: text("request_id"),
    ipHash: text("ip_hash"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_actor_created_idx").on(t.actorId, t.createdAt.desc()),
    index("audit_action_created_idx").on(t.action, t.createdAt.desc()),
    index("audit_target_idx").on(t.targetType, t.targetId, t.createdAt.desc()),
    index("audit_created_idx").on(t.createdAt.desc()),
    check("audit_actor_type_valid", sql`${t.actorType} IN ('user','admin','system')`),
  ],
);

/** Security-relevant occurrences, including failures that never became actions. */
export const securityEvent = pgTable(
  "security_events",
  {
    id: text("id").primaryKey(),
    type: securityEventTypeEnum("type").notNull(),
    /** 'info' | 'warning' | 'critical' */
    severity: text("severity").notNull().default("info"),
    /** Null when the actor could not be identified (e.g. failed login). */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /**
     * Case-folded email the attempt targeted. Recorded for failed logins so an
     * attack on one account is visible, but NEVER echoed back to a client —
     * doing so would defeat email-enumeration protection.
     */
    targetEmail: text("target_email"),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("security_type_created_idx").on(t.type, t.createdAt.desc()),
    index("security_user_created_idx").on(t.userId, t.createdAt.desc()),
    index("security_ip_created_idx").on(t.ipHash, t.createdAt.desc()),
    index("security_created_idx").on(t.createdAt.desc()),
    check("security_severity_valid", sql`${t.severity} IN ('info','warning','critical')`),
  ],
);

/** Standing suspicion attached to a subject, used to tighten limits. */
export const abuseFlag = pgTable(
  "abuse_flags",
  {
    id: text("id").primaryKey(),
    /** 'user' | 'ip' | 'email_domain' */
    subjectType: text("subject_type").notNull(),
    /** User id, IP hash, or domain — never a raw IP. */
    subjectKey: text("subject_key").notNull(),
    /** e.g. `code_brute_force`, `signup_burst`. */
    kind: text("kind").notNull(),
    severity: text("severity").notNull().default("warning"),
    hitCount: integer("hit_count").notNull().default(1),
    /** When set, the subject is under an elevated-scrutiny window. */
    activeUntil: tsCol("active_until"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: tsCol("updated_at").notNull().defaultNow(),
    resolvedAt: tsCol("resolved_at"),
    resolvedBy: text("resolved_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [
    index("abuse_subject_idx").on(t.subjectType, t.subjectKey),
    index("abuse_active_idx").on(t.activeUntil),
    index("abuse_created_idx").on(t.createdAt.desc()),
    check("abuse_subject_type_valid", sql`${t.subjectType} IN ('user','ip','email_domain')`),
  ],
);

/**
 * Fixed-window rate-limit counters.
 *
 * Postgres is the counter store in V1. Every limited action already runs a
 * transaction against Postgres, so this adds no new dependency, and an
 * `INSERT ... ON CONFLICT DO UPDATE` gives an atomic increment. Cloudflare's
 * edge rate limiting sits in front as a coarse first line of defence; this
 * table implements the per-account and per-action policy the brief specifies.
 * No Redis is introduced.
 */
export const rateLimitEvent = pgTable(
  "rate_limit_events",
  {
    id: text("id").primaryKey(),
    /** Policy name, e.g. `auth.login`, `code.redeem`. */
    bucket: text("bucket").notNull(),
    /** Scoped subject: `user:<id>`, `ip:<hash>`, `email:<normalized>`. */
    subject: text("subject").notNull(),
    /** Start of the fixed window. (bucket, subject, windowStart) is unique. */
    windowStart: tsCol("window_start").notNull(),
    windowSeconds: integer("window_seconds").notNull(),
    count: integer("count").notNull().default(1),
    /** True once the limit was exceeded in this window; drives the admin view. */
    blocked: boolean("blocked").notNull().default(false),
    lastSeenAt: tsCol("last_seen_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    /**
     * UNIQUE, not merely an index: the limiter's atomic
     * `INSERT ... ON CONFLICT DO UPDATE` needs this exact conflict target, and
     * without uniqueness two concurrent requests could each insert a fresh
     * window row and both read a count of 1 — silently doubling every limit.
     */
    uniqueIndex("rate_limit_window_key").on(t.bucket, t.subject, t.windowStart),
    index("rate_limit_window_idx").on(t.windowStart),
    index("rate_limit_blocked_idx").on(t.blocked, t.createdAt.desc()),
    check("rate_limit_count_positive", sql`${t.count} >= 0`),
  ],
);

/**
 * First-party product analytics.
 *
 * Events are stored here rather than shipped to a third party, so no email,
 * access code, cookie or form content ever leaves the origin. `anonymousId` is
 * a random client-generated id; `userId` is only attached after login AND
 * after the user has consented to product analytics.
 */
export const analyticsEvent = pgTable(
  "analytics_events",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    anonymousId: text("anonymous_id"),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** 'mobile' | 'tablet' | 'desktop' — coarse, derived server-side. */
    deviceCategory: text("device_category"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    referrer: text("referrer"),
    landingPath: text("landing_path"),
    path: text("path"),
    /** Allowlisted, non-sensitive properties only; validated by Zod. */
    properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("analytics_name_created_idx").on(t.name, t.createdAt.desc()),
    index("analytics_user_idx").on(t.userId, t.createdAt.desc()),
    index("analytics_anon_idx").on(t.anonymousId, t.createdAt.desc()),
    index("analytics_created_idx").on(t.createdAt.desc()),
  ],
);

export const auditRelations = relations(auditEvent, ({ one }) => ({
  actor: one(user, { fields: [auditEvent.actorId], references: [user.id] }),
}));

export const securityRelations = relations(securityEvent, ({ one }) => ({
  user: one(user, { fields: [securityEvent.userId], references: [user.id] }),
}));

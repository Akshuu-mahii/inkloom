import { relations, sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
  consentTypeEnum,
  createdAt,
  emailStatusEnum,
  exportStatusEnum,
  notificationKindEnum,
  tsCol,
  updatedAt,
} from "./_shared";
import { user } from "./auth";

/**
 * Consent records, append-only in spirit: granting and withdrawing both write
 * a new row rather than mutating an old one, so "what did this user agree to,
 * and when" is answerable for any point in time.
 *
 * Transactional email is NOT consent-gated (it is required to operate the
 * account); marketing email is, and is stored as a separate consent type.
 */
export const userConsent = pgTable(
  "user_consents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: consentTypeEnum("type").notNull(),
    granted: boolean("granted").notNull(),
    /** Version of the document consented to, e.g. "terms-2026-09-01". */
    documentVersion: text("document_version"),
    ipHash: text("ip_hash"),
    /** 'signup' | 'settings' | 'cookie_banner' | 'admin' */
    source: text("source").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("consents_user_type_idx").on(t.userId, t.type, t.createdAt.desc()),
    index("consents_created_idx").on(t.createdAt.desc()),
  ],
);

export const notificationPreference = pgTable(
  "notification_preferences",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * Security email cannot be disabled — a user must always learn that their
     * password changed. The column exists for completeness and is pinned true
     * by a check constraint so no UI or API bug can switch it off.
     */
    securityEmail: boolean("security_email").notNull().default(true),
    productUpdatesEmail: boolean("product_updates_email").notNull().default(true),
    marketingEmail: boolean("marketing_email").notNull().default(false),
    creditsEmail: boolean("credits_email").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("notification_prefs_user_key").on(t.userId),
    check("notification_prefs_security_always_on", sql`${t.securityEmail} = true`),
  ],
);

/** In-app notifications shown on the dashboard. */
export const notification = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: notificationKindEnum("kind").notNull(),
    title: text("title").notNull(),
    /** Plain text. Rendered as text, never as HTML. */
    body: text("body").notNull(),
    /** Internal path only; validated against an allowlist before render. */
    actionPath: text("action_path"),
    readAt: tsCol("read_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_user_created_idx").on(t.userId, t.createdAt.desc()),
    index("notifications_user_unread_idx").on(t.userId, t.readAt),
  ],
);

/**
 * Delivery log for transactional email.
 *
 * Records that a message of a given template was sent, its provider id and its
 * delivery outcome. It NEVER stores the rendered body, the signed link, or the
 * token inside it — only enough to debug deliverability and to drive the
 * "email delivery failures" alert.
 */
export const emailEvent = pgTable(
  "email_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** Case-folded recipient. */
    toEmail: text("to_email").notNull(),
    template: text("template").notNull(),
    subject: text("subject").notNull(),
    status: emailStatusEnum("status").notNull().default("queued"),
    /** Resend's message id, for cross-referencing in their dashboard. */
    providerMessageId: text("provider_message_id"),
    /** Provider error text on failure. Never contains the message body. */
    error: text("error"),
    requestId: text("request_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("email_events_status_created_idx").on(t.status, t.createdAt.desc()),
    index("email_events_user_idx").on(t.userId, t.createdAt.desc()),
    index("email_events_template_idx").on(t.template, t.createdAt.desc()),
    index("email_events_to_idx").on(t.toEmail),
  ],
);

/** GDPR-style data export requests. */
export const dataExportRequest = pgTable(
  "data_export_requests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: exportStatusEnum("status").notNull().default("requested"),
    /**
     * The generated JSON export, held inline. V1 has no R2 bucket; when object
     * storage lands in V2 this becomes a key and the column is dropped.
     */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    error: text("error"),
    requestedAt: createdAt(),
    completedAt: tsCol("completed_at"),
    /** Exports self-destruct; the row is kept, the payload is nulled. */
    expiresAt: tsCol("expires_at"),
  },
  (t) => [
    index("exports_user_idx").on(t.userId, t.requestedAt.desc()),
    index("exports_status_idx").on(t.status),
  ],
);

export const consentRelations = relations(userConsent, ({ one }) => ({
  user: one(user, { fields: [userConsent.userId], references: [user.id] }),
}));

export const notificationRelations = relations(notification, ({ one }) => ({
  user: one(user, { fields: [notification.userId], references: [user.id] }),
}));

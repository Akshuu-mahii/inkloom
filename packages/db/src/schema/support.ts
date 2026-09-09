import { relations } from "drizzle-orm";
import { index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
  createdAt,
  supportCategoryEnum,
  supportPriorityEnum,
  supportStatusEnum,
  tsCol,
  updatedAt,
} from "./_shared";
import { user } from "./auth";

export const supportRequest = pgTable(
  "support_requests",
  {
    id: text("id").primaryKey(),
    /**
     * Short, human-quotable reference shown to the user and in email,
     * e.g. `INK-7F3K2Q`. Distinct from the internal id so support can ask
     * "what's your reference?" without exposing an internal identifier.
     */
    reference: text("reference").notNull(),
    /** Null for submissions from the public /contact form. */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** Case-folded contact address; required even for signed-in users. */
    email: text("email").notNull(),
    name: text("name"),
    category: supportCategoryEnum("category").notNull().default("other"),
    priority: supportPriorityEnum("priority").notNull().default("normal"),
    status: supportStatusEnum("status").notNull().default("open"),
    subject: text("subject").notNull(),
    /** User-supplied. Stored and rendered as plain text, never as HTML. */
    message: text("message").notNull(),
    /** Page the user submitted from, plus coarse device info. No PII. */
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    ipHash: text("ip_hash"),
    requestId: text("request_id"),
    assignedTo: text("assigned_to").references(() => user.id, { onDelete: "set null" }),
    resolvedAt: tsCol("resolved_at"),
    resolvedBy: text("resolved_by").references(() => user.id, { onDelete: "set null" }),
    /** Shown to the user on their request-status page. */
    resolutionNote: text("resolution_note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("support_reference_key").on(t.reference),
    index("support_status_created_idx").on(t.status, t.createdAt.desc()),
    index("support_user_idx").on(t.userId, t.createdAt.desc()),
    index("support_email_idx").on(t.email),
    index("support_priority_idx").on(t.priority, t.status),
  ],
);

/**
 * Internal notes. Visible only to staff roles — never serialised onto any
 * user-facing endpoint, and excluded from the user's own data export.
 */
export const adminNote = pgTable(
  "admin_notes",
  {
    id: text("id").primaryKey(),
    /** 'user' | 'support_request' | 'campaign' */
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("admin_notes_subject_idx").on(t.subjectType, t.subjectId, t.createdAt.desc()),
    index("admin_notes_author_idx").on(t.authorId),
  ],
);

export const supportRelations = relations(supportRequest, ({ one }) => ({
  user: one(user, { fields: [supportRequest.userId], references: [user.id] }),
}));

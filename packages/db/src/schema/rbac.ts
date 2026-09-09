import { relations, sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, roleNameEnum, tsCol, updatedAt } from "./_shared";
import { user } from "./auth";

/**
 * Roles are seeded rows, not free strings, so a typo can never silently create
 * a role that no policy grants and no policy denies.
 *
 * `users.role` (the Better Auth admin-plugin column) mirrors the HIGHEST-rank
 * active grant in `user_roles`. `user_roles` is the authoritative, auditable
 * record — who granted what, when, and why. `RoleService.setRole` writes both
 * inside one transaction; `pnpm credits:reconcile --roles` reports any drift.
 */
export const role = pgTable(
  "roles",
  {
    id: text("id").primaryKey(),
    name: roleNameEnum("name").notNull(),
    /** Higher rank wins when computing the mirrored `users.role`. */
    rank: integer("rank").notNull(),
    description: text("description").notNull(),
    /** Permission keys granted by this role; the source of truth for policy. */
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("roles_name_key").on(t.name), uniqueIndex("roles_rank_key").on(t.rank)],
);

export const userRole = pgTable(
  "user_roles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => role.id, { onDelete: "restrict" }),
    /** Null for the bootstrap super-admin created by the one-time CLI. */
    grantedBy: text("granted_by").references(() => user.id, { onDelete: "set null" }),
    grantedAt: createdAt(),
    /** Required for every grant made through the admin API. */
    reason: text("reason"),
    revokedAt: tsCol("revoked_at"),
    revokedBy: text("revoked_by").references(() => user.id, { onDelete: "set null" }),
    revokedReason: text("revoked_reason"),
  },
  (t) => [
    // A user holds a given role at most once at a time. Revoked grants keep
    // their history row, so the partial index only covers live grants.
    uniqueIndex("user_roles_active_key")
      .on(t.userId, t.roleId)
      .where(sql`${t.revokedAt} IS NULL`),
    index("user_roles_user_idx").on(t.userId),
    index("user_roles_role_idx").on(t.roleId),
  ],
);

export const roleRelations = relations(role, ({ many }) => ({ grants: many(userRole) }));

export const userRoleRelations = relations(userRole, ({ one }) => ({
  user: one(user, { fields: [userRole.userId], references: [user.id], relationName: "holder" }),
  role: one(role, { fields: [userRole.roleId], references: [role.id] }),
}));

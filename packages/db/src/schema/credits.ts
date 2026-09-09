import { relations, sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  createdAt,
  ledgerActorEnum,
  ledgerRefEnum,
  ledgerTypeEnum,
  tsCol,
  updatedAt,
} from "./_shared";
import { user } from "./auth";

/**
 * Cached wallet balance.
 *
 * This is a CACHE, not the truth. `credit_ledger` is the truth. The wallet
 * exists so that reading a balance is one indexed row-read instead of a sum
 * over the user's whole history.
 *
 * Every mutation updates the wallet and appends a ledger entry in the SAME
 * transaction, under a row lock on the wallet, and stamps the resulting
 * balance into `credit_ledger.balance_after`. `pnpm credits:reconcile` re-sums
 * the ledger per user and reports (or repairs) any wallet that disagrees.
 */
export const creditWallet = pgTable(
  "credit_wallets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Cached balance. Must always equal SUM(credit_ledger.amount) for the user. */
    balance: integer("balance").notNull().default(0),
    /**
     * Monotonic counter incremented on every mutation. Lets a reader detect a
     * concurrent write, and gives reconciliation a cheap change signal.
     */
    version: bigint("version", { mode: "number" }).notNull().default(0),
    lastEntryId: text("last_entry_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("credit_wallets_user_key").on(t.userId),
    /**
     * Credits can never go negative. This is a database-level guarantee: a bug
     * in the service layer that tried to over-deduct would abort the
     * transaction rather than produce a negative balance.
     */
    check("credit_wallets_balance_non_negative", sql`${t.balance} >= 0`),
  ],
);

/**
 * The immutable credit ledger — the accounting source of truth.
 *
 * Append-only by policy AND by permission: migration 0002 revokes UPDATE and
 * DELETE on this table from the application role, so an incorrect entry can
 * only be corrected by appending a compensating `REVERSAL` entry. Nothing in
 * the admin UI or API can delete history.
 */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: text("id").primaryKey(),
    /**
     * `restrict`, not `cascade`: a ledger entry outlives the account it belongs
     * to. Account deletion anonymises the user row and keeps the accounting
     * record, as the retention policy requires. A hard DELETE of a user with
     * ledger history fails here, loudly, instead of being silently swallowed.
     */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    walletId: text("wallet_id")
      .notNull()
      .references(() => creditWallet.id, { onDelete: "restrict" }),

    /** Signed: positive grants, negative deducts. Never zero. */
    amount: integer("amount").notNull(),
    type: ledgerTypeEnum("type").notNull(),
    /** Wallet balance immediately after this entry was applied. */
    balanceAfter: integer("balance_after").notNull(),

    referenceType: ledgerRefEnum("reference_type").notNull(),
    /** Id of the redemption / adjustment / reversed entry this entry relates to. */
    referenceId: text("reference_id"),

    /**
     * Every mutation carries one. A retry with the same key returns the
     * original entry instead of granting twice — see `idempotency_keys`.
     */
    idempotencyKey: text("idempotency_key").notNull(),

    actorType: ledgerActorEnum("actor_type").notNull(),
    /** Null when actorType is 'system'. */
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),

    /** Mandatory human explanation. Admin adjustments cannot omit it. */
    reason: text("reason").notNull(),

    /** Validated against a strict Zod schema before insert; see @inkloom/core. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),

    createdAt: createdAt(),
  },
  (t) => [
    /** Idempotency is global, not per-user: a replayed key can never double-grant. */
    uniqueIndex("credit_ledger_idempotency_key").on(t.idempotencyKey),
    index("credit_ledger_user_created_idx").on(t.userId, t.createdAt.desc()),
    index("credit_ledger_type_created_idx").on(t.type, t.createdAt.desc()),
    index("credit_ledger_reference_idx").on(t.referenceType, t.referenceId),
    index("credit_ledger_actor_idx").on(t.actorId, t.createdAt.desc()),
    check("credit_ledger_amount_non_zero", sql`${t.amount} <> 0`),
    check("credit_ledger_balance_non_negative", sql`${t.balanceAfter} >= 0`),
    check("credit_ledger_reason_not_blank", sql`length(btrim(${t.reason})) > 0`),
    /**
     * V2 ledger types are present in the enum so payments and generation can be
     * added without a destructive migration, but no V1 row may use one.
     * Migration 0003 drops this constraint as part of enabling V2.
     */
    check(
      "credit_ledger_v1_types_only",
      sql`${t.type} IN ('EARLY_ACCESS_GRANT','PROMOTIONAL_GRANT','ADMIN_GRANT','ADMIN_DEDUCTION','EXPIRY','REVERSAL')`,
    ),
    /** Sign must match intent: grants add, deductions subtract. */
    check(
      "credit_ledger_sign_matches_type",
      sql`
        (${t.type} IN ('EARLY_ACCESS_GRANT','PROMOTIONAL_GRANT','ADMIN_GRANT') AND ${t.amount} > 0)
        OR (${t.type} IN ('ADMIN_DEDUCTION','EXPIRY') AND ${t.amount} < 0)
        OR (${t.type} = 'REVERSAL')
        OR (${t.type} IN ('PURCHASE','GENERATION_RESERVE','GENERATION_CAPTURE','GENERATION_RELEASE','PAYMENT_REFUND'))
      `,
    ),
  ],
);

/**
 * Idempotency register.
 *
 * Claimed BEFORE the work is attempted, inside the same transaction, so two
 * concurrent requests carrying the same key cannot both proceed. The response
 * body of the winning request is stored so a retry returns a byte-identical
 * answer rather than a confusing "already done" error.
 */
export const idempotencyKey = pgTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(),
    /** The client- or server-supplied key. Unique across the whole system. */
    key: text("key").notNull(),
    /** Logical operation, e.g. `access_code.redeem`. Guards key reuse across endpoints. */
    scope: text("scope").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    /** Hash of the request body; a same-key-different-body retry is rejected. */
    requestHash: text("request_hash").notNull(),
    /** Cached success response, replayed verbatim on retry. */
    responseBody: jsonb("response_body").$type<Record<string, unknown>>(),
    responseStatus: integer("response_status"),
    /** 'in_progress' | 'completed' | 'failed' */
    state: text("state").notNull().default("in_progress"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    expiresAt: tsCol("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("idempotency_keys_scope_key").on(t.scope, t.key),
    index("idempotency_keys_expires_idx").on(t.expiresAt),
    index("idempotency_keys_user_idx").on(t.userId),
    check("idempotency_keys_state_valid", sql`${t.state} IN ('in_progress','completed','failed')`),
  ],
);

export const creditWalletRelations = relations(creditWallet, ({ one, many }) => ({
  user: one(user, { fields: [creditWallet.userId], references: [user.id] }),
  entries: many(creditLedger),
}));

export const creditLedgerRelations = relations(creditLedger, ({ one }) => ({
  user: one(user, { fields: [creditLedger.userId], references: [user.id], relationName: "owner" }),
  wallet: one(creditWallet, {
    fields: [creditLedger.walletId],
    references: [creditWallet.id],
  }),
}));

/**
 * Credit accounting.
 *
 * Invariants this module is responsible for, all of which are exercised by
 * `ledger.integration.test.ts` and `redemption.concurrency.test.ts`:
 *
 *   1. The ledger is the source of truth; the wallet is a cache that must
 *      always equal SUM(ledger.amount) for the user.
 *   2. Every change is atomic — a wallet update and its ledger entry commit
 *      together or not at all.
 *   3. Credits never go negative (enforced here AND by a CHECK constraint).
 *   4. Every mutation carries an idempotency key; a replay returns the original
 *      result instead of applying twice.
 *   5. Nothing is ever updated or deleted — corrections are new REVERSAL rows.
 *      (Enforced by a database trigger, so this is not merely a convention.)
 *   6. A balance supplied by a client is never trusted; it is always read from
 *      the locked wallet row inside the transaction.
 */
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { Database, Executor } from "@inkloom/db/client";
import { creditLedger, creditWallet, idempotencyKey, newId } from "@inkloom/db";
import { fail } from "../util/errors";
import type { Logger } from "../util/logger";
import { sha256Hex } from "../util/crypto";
import {
  assertV1LedgerType,
  ledgerMetadataSchema,
  type LedgerActorType,
  type LedgerEntryView,
  type LedgerMetadata,
  type LedgerRefType,
  type V1LedgerType,
} from "./types";

export interface ApplyEntryParams {
  userId: string;
  /** Signed. Positive grants, negative deducts. Zero is rejected. */
  amount: number;
  type: V1LedgerType;
  referenceType: LedgerRefType;
  referenceId?: string | null;
  idempotencyKey: string;
  actorType: LedgerActorType;
  actorId?: string | null;
  reason: string;
  metadata?: LedgerMetadata;
}

export interface WalletSnapshot {
  walletId: string;
  balance: number;
  version: number;
}

/** How long a completed idempotency record is replayable. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export class CreditService {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  /**
   * Read a user's balance. Creates the wallet lazily on first read so that a
   * user who has never been granted anything still sees a real zero rather than
   * a null.
   */
  async getBalance(userId: string): Promise<WalletSnapshot> {
    const existing = await this.db.query.creditWallet.findFirst({
      where: eq(creditWallet.userId, userId),
    });
    if (existing) {
      return { walletId: existing.id, balance: existing.balance, version: existing.version };
    }
    return this.db.transaction((tx) => this.ensureWallet(tx, userId));
  }

  /**
   * Get or create the wallet row. Uses ON CONFLICT DO UPDATE rather than
   * "check then insert" so two concurrent first-time reads cannot both insert.
   */
  async ensureWallet(tx: Executor, userId: string): Promise<WalletSnapshot> {
    const [row] = await tx
      .insert(creditWallet)
      .values({ id: newId("wal"), userId, balance: 0, version: 0 })
      .onConflictDoUpdate({
        target: creditWallet.userId,
        // A no-op update is what makes the row come back in RETURNING.
        set: { userId: sql`excluded.user_id` },
      })
      .returning();

    if (!row) throw new Error(`Failed to materialise wallet for user ${userId}`);
    return { walletId: row.id, balance: row.balance, version: row.version };
  }

  /**
   * Lock the wallet row for the remainder of the transaction.
   *
   * This is what serialises concurrent mutations for one user: two admins
   * adjusting the same wallet queue behind each other, and each computes
   * `balanceAfter` from a balance nobody else can be changing.
   */
  private async lockWallet(tx: Executor, walletId: string): Promise<WalletSnapshot> {
    const locked = await tx.execute<{ id: string; balance: number; version: string }>(
      sql`SELECT id, balance, version FROM credit_wallets WHERE id = ${walletId} FOR UPDATE`,
    );
    const row = locked.rows[0];
    if (!row) throw new Error(`Wallet ${walletId} disappeared inside a transaction`);
    return { walletId: row.id, balance: Number(row.balance), version: Number(row.version) };
  }

  /**
   * THE core primitive: append one ledger entry and move the cached balance,
   * inside the caller's transaction.
   *
   * Callers must already hold whatever higher-level lock their operation needs
   * (e.g. the campaign row for a redemption). This method takes the wallet lock
   * itself.
   */
  async applyEntry(tx: Executor, params: ApplyEntryParams): Promise<LedgerEntryView> {
    assertV1LedgerType(params.type);

    if (!Number.isInteger(params.amount) || params.amount === 0) {
      throw new Error(`Ledger amount must be a non-zero integer (got ${params.amount})`);
    }
    if (!params.reason.trim()) {
      throw fail("REASON_REQUIRED");
    }

    const metadata = ledgerMetadataSchema.parse(params.metadata ?? {});

    const wallet = await this.ensureWallet(tx, params.userId);
    const locked = await this.lockWallet(tx, wallet.walletId);

    const balanceAfter = locked.balance + params.amount;

    if (balanceAfter < 0) {
      // Deliberately a domain error, not a crash: an admin over-deducting is a
      // normal mistake and should get a clear message, not a 500.
      throw fail("INSUFFICIENT_CREDITS", {
        details: { balance: locked.balance, requested: Math.abs(params.amount) },
      });
    }

    const entryId = newId("led");

    const [entry] = await tx
      .insert(creditLedger)
      .values({
        id: entryId,
        userId: params.userId,
        walletId: locked.walletId,
        amount: params.amount,
        type: params.type,
        balanceAfter,
        referenceType: params.referenceType,
        referenceId: params.referenceId ?? null,
        idempotencyKey: params.idempotencyKey,
        actorType: params.actorType,
        actorId: params.actorId ?? null,
        reason: params.reason.trim(),
        metadata: { ...metadata, balanceBefore: locked.balance },
      })
      .returning();

    if (!entry) throw new Error("Ledger insert returned no row");

    await tx
      .update(creditWallet)
      .set({
        balance: balanceAfter,
        version: locked.version + 1,
        lastEntryId: entryId,
        updatedAt: new Date(),
      })
      .where(eq(creditWallet.id, locked.walletId));

    return toView(entry);
  }

  /**
   * Apply an entry in its own transaction, guarded by an idempotency key.
   *
   * The key is claimed BEFORE the work, inside the same transaction, so two
   * concurrent requests carrying one key cannot both proceed: the loser's
   * INSERT collides on `(scope, key)` and its transaction rolls back whole.
   */
  async applyIdempotent(
    params: ApplyEntryParams & { scope: string; requestBody?: unknown },
  ): Promise<{ entry: LedgerEntryView; replayed: boolean }> {
    const requestHash = await sha256Hex(
      JSON.stringify(
        params.requestBody ?? {
          userId: params.userId,
          amount: params.amount,
          type: params.type,
        },
      ),
    );

    const cached = await this.findCompleted(params.scope, params.idempotencyKey, requestHash);
    if (cached) return { entry: cached, replayed: true };

    try {
      const entry = await this.db.transaction(async (tx) => {
        await this.claimIdempotencyKey(tx, {
          scope: params.scope,
          key: params.idempotencyKey,
          userId: params.userId,
          requestHash,
        });
        const created = await this.applyEntry(tx, params);
        await this.completeIdempotencyKey(tx, params.scope, params.idempotencyKey, created.id);
        return created;
      });
      return { entry, replayed: false };
    } catch (error) {
      // Lost the race to claim the key: the winner's result is authoritative.
      if (isUniqueViolation(error)) {
        const replay = await this.findCompleted(params.scope, params.idempotencyKey, requestHash);
        if (replay) return { entry: replay, replayed: true };
      }
      throw error;
    }
  }

  /** Insert the idempotency claim. Throws a unique violation if already taken. */
  async claimIdempotencyKey(
    tx: Executor,
    params: { scope: string; key: string; userId?: string | null; requestHash: string },
  ): Promise<void> {
    await tx.insert(idempotencyKey).values({
      id: newId("idem"),
      key: params.key,
      scope: params.scope,
      userId: params.userId ?? null,
      requestHash: params.requestHash,
      state: "in_progress",
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    });
  }

  async completeIdempotencyKey(
    tx: Executor,
    scope: string,
    key: string,
    ledgerEntryId: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await tx
      .update(idempotencyKey)
      .set({
        state: "completed",
        responseStatus: 200,
        responseBody: { ledgerEntryId, ...extra },
        updatedAt: new Date(),
      })
      .where(and(eq(idempotencyKey.scope, scope), eq(idempotencyKey.key, key)));
  }

  /**
   * Look up a previously completed operation for this key.
   *
   * A same-key-different-body retry is a client bug and is rejected loudly
   * rather than silently returning someone else's result.
   */
  private async findCompleted(
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<LedgerEntryView | null> {
    const record = await this.db.query.idempotencyKey.findFirst({
      where: and(eq(idempotencyKey.scope, scope), eq(idempotencyKey.key, key)),
    });
    if (!record || record.state !== "completed") return null;

    if (record.requestHash !== requestHash) {
      throw fail("IDEMPOTENCY_CONFLICT");
    }

    const entryId = (record.responseBody as { ledgerEntryId?: string } | null)?.ledgerEntryId;
    if (!entryId) return null;

    const entry = await this.db.query.creditLedger.findFirst({
      where: eq(creditLedger.id, entryId),
    });
    return entry ? toView(entry) : null;
  }

  /** Admin grant or deduction. A reason is mandatory and is stored on the entry. */
  async adminAdjust(params: {
    userId: string;
    amount: number;
    reason: string;
    adminId: string;
    idempotencyKey: string;
    requestId?: string;
    adminNote?: string;
  }): Promise<{ entry: LedgerEntryView; replayed: boolean }> {
    if (!params.reason?.trim()) throw fail("REASON_REQUIRED");
    if (params.amount === 0) {
      throw fail("VALIDATION_ERROR", { details: { amount: "must not be zero" } });
    }

    return this.applyIdempotent({
      scope: "credits.admin_adjust",
      userId: params.userId,
      amount: params.amount,
      type: params.amount > 0 ? "ADMIN_GRANT" : "ADMIN_DEDUCTION",
      referenceType: "admin_adjustment",
      referenceId: params.adminId,
      idempotencyKey: params.idempotencyKey,
      actorType: "admin",
      actorId: params.adminId,
      reason: params.reason,
      metadata: {
        adminNote: params.adminNote,
        requestId: params.requestId,
      },
      requestBody: {
        userId: params.userId,
        amount: params.amount,
        reason: params.reason.trim(),
      },
    });
  }

  /**
   * Reverse a previous entry by appending its inverse.
   *
   * The original row is never touched — it cannot be, the trigger forbids it.
   * Reversing twice is refused, so a double-click cannot swing the balance
   * twice in the same direction.
   */
  async reverse(params: {
    entryId: string;
    reason: string;
    adminId: string;
    idempotencyKey: string;
  }): Promise<{ entry: LedgerEntryView; replayed: boolean }> {
    if (!params.reason?.trim()) throw fail("REASON_REQUIRED");

    const original = await this.db.query.creditLedger.findFirst({
      where: eq(creditLedger.id, params.entryId),
    });
    if (!original) throw fail("NOT_FOUND");

    if (original.type === "REVERSAL") {
      throw fail("CONFLICT", {
        details: { reason: "A reversal cannot itself be reversed." },
      });
    }

    const existingReversal = await this.db.query.creditLedger.findFirst({
      where: and(
        eq(creditLedger.referenceType, "reversal"),
        eq(creditLedger.referenceId, params.entryId),
      ),
    });
    if (existingReversal) {
      throw fail("CONFLICT", { details: { reason: "This entry has already been reversed." } });
    }

    return this.applyIdempotent({
      scope: "credits.reverse",
      userId: original.userId,
      amount: -original.amount,
      type: "REVERSAL",
      referenceType: "reversal",
      referenceId: original.id,
      idempotencyKey: params.idempotencyKey,
      actorType: "admin",
      actorId: params.adminId,
      reason: params.reason,
      metadata: {
        reversedEntryId: original.id,
        reversalOfType: original.type as V1LedgerType,
      },
      requestBody: { entryId: params.entryId, reason: params.reason.trim() },
    });
  }

  /** Keyset-paginated history, newest first. */
  async history(params: {
    userId: string;
    limit?: number;
    before?: Date;
  }): Promise<{ entries: LedgerEntryView[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);

    const rows = await this.db.query.creditLedger.findMany({
      where: params.before
        ? and(eq(creditLedger.userId, params.userId), lt(creditLedger.createdAt, params.before))
        : eq(creditLedger.userId, params.userId),
      orderBy: [desc(creditLedger.createdAt), desc(creditLedger.id)],
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      entries: page.map(toView),
      nextCursor: hasMore ? (page.at(-1)?.createdAt.toISOString() ?? null) : null,
    };
  }

  /**
   * Recompute every wallet from its ledger and report disagreements.
   *
   * Read-only unless `repair` is set. Repair appends nothing to the ledger — it
   * only corrects the CACHE to match the truth, which is the only safe
   * direction: the ledger is never rewritten to match a wallet.
   */
  async reconcile(options: { repair?: boolean } = {}): Promise<{
    checked: number;
    drifted: Array<{ walletId: string; userId: string; cached: number; actual: number }>;
    repaired: number;
  }> {
    const drift = await this.db.execute<{
      wallet_id: string;
      user_id: string;
      cached_balance: number;
      ledger_balance: number;
    }>(sql`SELECT wallet_id, user_id, cached_balance, ledger_balance FROM credit_wallet_drift`);

    const total = await this.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM credit_wallets`,
    );

    const drifted = drift.rows.map((r) => ({
      walletId: r.wallet_id,
      userId: r.user_id,
      cached: Number(r.cached_balance),
      actual: Number(r.ledger_balance),
    }));

    let repaired = 0;
    if (options.repair && drifted.length > 0) {
      for (const row of drifted) {
        await this.db.transaction(async (tx) => {
          const locked = await this.lockWallet(tx, row.walletId);
          const actual = await tx.execute<{ sum: string }>(
            sql`SELECT COALESCE(SUM(amount),0)::text AS sum FROM credit_ledger WHERE wallet_id = ${row.walletId}`,
          );
          const trueBalance = Number(actual.rows[0]?.sum ?? 0);
          await tx
            .update(creditWallet)
            .set({ balance: trueBalance, version: locked.version + 1, updatedAt: new Date() })
            .where(eq(creditWallet.id, row.walletId));
        });
        repaired += 1;
        this.logger.warn("credit_wallet_repaired", {
          walletId: row.walletId,
          from: row.cached,
          to: row.actual,
        });
      }
    }

    return { checked: Number(total.rows[0]?.count ?? 0), drifted, repaired };
  }
}

function toView(entry: typeof creditLedger.$inferSelect): LedgerEntryView {
  return {
    id: entry.id,
    amount: entry.amount,
    type: entry.type as V1LedgerType,
    balanceAfter: entry.balanceAfter,
    reason: entry.reason,
    referenceType: entry.referenceType as LedgerRefType,
    referenceId: entry.referenceId,
    actorType: entry.actorType as LedgerActorType,
    createdAt: entry.createdAt,
    metadata: (entry.metadata ?? {}) as LedgerMetadata,
  };
}

/**
 * Postgres unique-violation SQLSTATE (23505).
 *
 * Drizzle wraps driver errors in a `DrizzleQueryError` whose `cause` is the
 * original `pg` error, so a naive top-level `error.code` check silently never
 * matches — which would quietly disable the unique-index backstop that the
 * concurrency guarantees depend on. The cause chain is walked instead.
 */
export function isUniqueViolation(error: unknown): boolean {
  return hasSqlState(error, "23505");
}

/** Postgres check-violation SQLSTATE (23514). */
export function isCheckViolation(error: unknown): boolean {
  return hasSqlState(error, "23514");
}

function hasSqlState(error: unknown, state: string, depth = 0): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false;
  if ("code" in error && (error as { code?: unknown }).code === state) return true;
  if ("cause" in error) return hasSqlState((error as { cause?: unknown }).cause, state, depth + 1);
  return false;
}

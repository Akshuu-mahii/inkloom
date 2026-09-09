import { z } from "zod";

/**
 * Ledger types that V1 may actually write. The Postgres enum additionally
 * carries the V2 types so payments and generation can be added without a
 * destructive migration, and a CHECK constraint plus this schema keep V1 from
 * emitting one by accident.
 */
export const V1_LEDGER_TYPES = [
  "EARLY_ACCESS_GRANT",
  "PROMOTIONAL_GRANT",
  "ADMIN_GRANT",
  "ADMIN_DEDUCTION",
  "EXPIRY",
  "REVERSAL",
] as const;

export const V2_LEDGER_TYPES = [
  "PURCHASE",
  "GENERATION_RESERVE",
  "GENERATION_CAPTURE",
  "GENERATION_RELEASE",
  "PAYMENT_REFUND",
] as const;

export const v1LedgerTypeSchema = z.enum(V1_LEDGER_TYPES);
export type V1LedgerType = z.infer<typeof v1LedgerTypeSchema>;

export const ledgerRefTypeSchema = z.enum([
  "access_code_redemption",
  "admin_adjustment",
  "reversal",
  "expiry_sweep",
  "system_bootstrap",
]);
export type LedgerRefType = z.infer<typeof ledgerRefTypeSchema>;

export const ledgerActorTypeSchema = z.enum(["user", "admin", "system"]);
export type LedgerActorType = z.infer<typeof ledgerActorTypeSchema>;

/**
 * Ledger metadata is a STRICT schema, not a free-form bag.
 *
 * `.strict()` means an unrecognised key is a validation error rather than
 * silently stored. That matters because metadata is written by admin-facing
 * code paths and rendered back in the admin UI: an open object would be a
 * pathway for storing unexpected — potentially sensitive — content in the
 * ledger, which is a table nobody can ever edit or delete.
 */
export const ledgerMetadataSchema = z
  .object({
    campaignId: z.string().optional(),
    campaignName: z.string().max(200).optional(),
    redemptionId: z.string().optional(),
    reversedEntryId: z.string().optional(),
    reversalOfType: z.enum(V1_LEDGER_TYPES).optional(),
    adminNote: z.string().max(500).optional(),
    /** Balance before the entry, denormalised for fast admin display. */
    balanceBefore: z.number().int().optional(),
    requestId: z.string().max(64).optional(),
    /** Set by the bootstrap/seed scripts so seeded data is identifiable. */
    seed: z.boolean().optional(),
    cohort: z.string().max(100).optional(),
  })
  .strict();

export type LedgerMetadata = z.infer<typeof ledgerMetadataSchema>;

export interface LedgerEntryView {
  id: string;
  amount: number;
  type: V1LedgerType;
  balanceAfter: number;
  reason: string;
  referenceType: LedgerRefType;
  referenceId: string | null;
  actorType: LedgerActorType;
  createdAt: Date;
  metadata: LedgerMetadata;
}

/** Throws if a caller ever tries to write a type reserved for V2. */
export function assertV1LedgerType(type: string): asserts type is V1LedgerType {
  if (!(V1_LEDGER_TYPES as readonly string[]).includes(type)) {
    throw new Error(
      `Ledger type "${type}" is reserved for V2 and must not be written in V1. ` +
        "Payments and generation are not enabled.",
    );
  }
}

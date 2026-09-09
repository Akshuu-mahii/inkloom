/**
 * Audit and security event recording.
 *
 * Two separate streams, on purpose:
 *
 *   audit_events    — deliberate, consequential ACTIONS, especially admin ones.
 *                     "Who did what to whom, when, and why."
 *   security_events — OCCURRENCES, including failures that never became an
 *                     action: rejected logins, tripped rate limits, refused
 *                     redemptions, blocked admin access attempts.
 *
 * Both tables are append-only. `audit_events` is enforced by a database
 * trigger, so even a bug in this file cannot rewrite history.
 *
 * Recording must never break the operation it describes: a failure to write a
 * security event is logged loudly but swallowed, because dropping a login for
 * an observability hiccup would be a worse outcome. Audit writes for admin
 * actions are the exception — they run inside the caller's transaction and are
 * allowed to abort it, so a credit adjustment cannot commit unaudited.
 */
import type { Executor, Database } from "@inkloom/db/client";
import { auditEvent, newId, securityEvent } from "@inkloom/db";
import type { Logger } from "../util/logger";

export interface AuditInput {
  action: string;
  actorType: "user" | "admin" | "system";
  actorId?: string | null;
  actorRole?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
  ipHash?: string | null;
}

export interface SecurityInput {
  type: string;
  severity?: "info" | "warning" | "critical";
  userId?: string | null;
  /** Case-folded. Recorded for operators; never echoed to a client. */
  targetEmail?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

export class AuditService {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  /**
   * Write an audit row inside the caller's transaction.
   *
   * Intentionally NOT error-swallowing: if the audit write fails, the whole
   * action rolls back. An unaudited admin credit adjustment is not an
   * acceptable outcome.
   */
  async record(tx: Executor, input: AuditInput): Promise<void> {
    await tx.insert(auditEvent).values({
      id: newId("aud"),
      action: input.action,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      actorRole: input.actorRole ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      reason: input.reason ?? null,
      metadata: input.metadata ?? {},
      requestId: input.requestId ?? null,
      ipHash: input.ipHash ?? null,
    });
  }

  /** Write an audit row in its own transaction, for callers not already in one. */
  async recordStandalone(input: AuditInput): Promise<void> {
    await this.record(this.db, input);
  }

  /**
   * Record a security event. Never throws — observability must not take down
   * the request it is observing.
   */
  async security(input: SecurityInput): Promise<void> {
    try {
      await this.db.insert(securityEvent).values({
        id: newId("sec"),
        type: input.type as never,
        severity: input.severity ?? "info",
        userId: input.userId ?? null,
        targetEmail: input.targetEmail?.toLowerCase() ?? null,
        ipHash: input.ipHash ?? null,
        userAgent: input.userAgent?.slice(0, 200) ?? null,
        requestId: input.requestId ?? null,
        metadata: input.metadata ?? {},
      });
    } catch (error) {
      this.logger.error("security_event_write_failed", { type: input.type, error });
    }
  }
}

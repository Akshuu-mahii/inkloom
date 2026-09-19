/**
 * What "production is fine" means, written once.
 *
 * Two things ask this question and they watch each other. The Worker's nightly
 * cron asks it and emails the owner; a scheduled GitHub job asks it and emails
 * the owner. Neither can report its own death — a cron that stops firing cannot
 * tell you it has stopped — so each one's freshness is a check the OTHER
 * performs. That mutual arrangement only works if both are measuring the same
 * thing, which is why this lives in core rather than in either caller.
 *
 * Everything here is read-only.
 */
import { sql } from "drizzle-orm";
import type { Database } from "@inkloom/db/client";
import {
  BACKUP_JOB,
  jobHealth,
  JOB_MAX_AGE_HOURS,
  RESTORE_TEST_JOB,
  RETENTION_JOB,
} from "../retention";

export type Severity = "critical" | "warning";

export interface HealthProblem {
  severity: Severity;
  /** Stable identifier, so an alert can be recognised as "the same one again". */
  code: string;
  summary: string;
  detail: string;
}

export interface HealthReport {
  checkedAt: Date;
  problems: HealthProblem[];
  /** Figures worth seeing even when nothing is wrong. */
  context: Record<string, string>;
}

/**
 * A scheduled job that has not run inside its window.
 *
 * `critical` for backups: an environment whose backups stopped is one bad
 * afternoon from losing everything, and the gap is invisible until the day it
 * matters. `warning` for the restore test, which is a week-long window and a
 * failure of assurance rather than of the thing being assured.
 */
const JOB_SEVERITY: Record<string, Severity> = {
  [BACKUP_JOB]: "critical",
  [RETENTION_JOB]: "warning",
  [RESTORE_TEST_JOB]: "warning",
};

export async function checkHealth(db: Database): Promise<HealthReport> {
  const problems: HealthProblem[] = [];
  const context: Record<string, string> = {};

  for (const job of [BACKUP_JOB, RETENTION_JOB, RESTORE_TEST_JOB]) {
    const health = await jobHealth(db, job, JOB_MAX_AGE_HOURS[job]);
    context[job] =
      health.ageHours === null ? "never run" : `${health.ageHours}h ago, ${health.lastStatus}`;

    if (!health.healthy) {
      problems.push({
        severity: JOB_SEVERITY[job] ?? "warning",
        code: `job.${job}`,
        summary: `The ${job.replace(/_/g, " ")} job is overdue`,
        detail:
          health.ageHours === null
            ? "It has never run."
            : `Last ran ${health.ageHours}h ago with status "${health.lastStatus}". ` +
              `The window is ${JOB_MAX_AGE_HOURS[job]}h.`,
      });
    }
  }

  /*
   * The ledger is the accounting record and a wallet is a cache of it. Drift
   * means one of them is lying, and there is no safe amount of that.
   */
  const drift = await db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM credit_wallets w
     WHERE w.balance <> COALESCE(
       (SELECT SUM(amount) FROM credit_ledger l WHERE l.user_id = w.user_id), 0)
  `);
  const drifted = drift.rows[0]?.n ?? "0";
  context.ledger_drift = drifted;
  if (Number(drifted) > 0) {
    problems.push({
      severity: "critical",
      code: "credits.drift",
      summary: "A wallet disagrees with the credit ledger",
      detail: `${drifted} wallet(s) drifted. Run \`pnpm credits:reconcile\` to see which.`,
    });
  }

  const errors = await db.execute<{ n: string }>(sql`
    SELECT COALESCE(SUM(status_5xx), 0)::text AS n FROM request_metrics
     WHERE updated_at > now() - interval '24 hours'
  `);
  const fiveXx = errors.rows[0]?.n ?? "0";
  context.errors_24h = fiveXx;
  if (Number(fiveXx) > 0) {
    problems.push({
      severity: "warning",
      code: "requests.5xx",
      summary: "The application returned server errors",
      detail: `${fiveXx} 5xx response(s) in the last 24 hours.`,
    });
  }

  const critical = await db.execute<{ n: string; newest: string | null }>(sql`
    SELECT COUNT(*)::text AS n, MAX(created_at)::text AS newest
      FROM security_events
     WHERE severity = 'critical' AND created_at > now() - interval '24 hours'
  `);
  const criticalCount = critical.rows[0]?.n ?? "0";
  const criticalNewest = critical.rows[0]?.newest ?? "unknown";
  context.critical_security_events_24h = criticalCount;
  if (Number(criticalCount) > 0) {
    problems.push({
      severity: "critical",
      code: "security.critical",
      summary: "Critical security events were recorded",
      detail: `${criticalCount} in the last 24 hours, newest at ${criticalNewest}.`,
    });
  }

  /*
   * Email that leaves and does not arrive. Verification mail is the whole
   * signup flow, so a provider problem reads to users as "the product is
   * broken" while every dashboard stays green.
   */
  const mail = await db.execute<{ failed: string; total: string }>(sql`
    SELECT COUNT(*) FILTER (WHERE status IN ('failed','bounced'))::text AS failed,
           COUNT(*)::text AS total
      FROM email_events WHERE created_at > now() - interval '24 hours'
  `);
  const mailFailed = mail.rows[0]?.failed ?? "0";
  const mailTotal = mail.rows[0]?.total ?? "0";
  context.email_24h = `${mailFailed} failed of ${mailTotal}`;
  if (Number(mailFailed) > 0) {
    problems.push({
      severity: "critical",
      code: "email.failed",
      summary: "Email is failing to deliver",
      detail: `${mailFailed} of ${mailTotal} message(s) failed or bounced in the last 24 hours.`,
    });
  }

  return { checkedAt: new Date(), problems, context };
}

/** Critical outranks warning; used to decide how loudly to say it. */
export function worstSeverity(problems: HealthProblem[]): Severity | null {
  if (problems.some((p) => p.severity === "critical")) return "critical";
  return problems.length > 0 ? "warning" : null;
}

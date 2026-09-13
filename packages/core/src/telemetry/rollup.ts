/**
 * Nightly business roll-up: one row per day in `daily_metrics`.
 *
 * Computed from the source tables rather than counted as events happen. That
 * ordering matters twice over: the request path stays untouched, and a figure
 * whose definition turns out to be wrong can simply be recomputed, which is
 * impossible once a counter has been incremented in place.
 *
 * WHERE EACH NUMBER COMES FROM, and why it is that source rather than an
 * easier one:
 *
 *   - Active users come from `sessions.last_active_at`, NOT from analytics.
 *     Analytics only fires for people who accepted the cookie notice, so a DAU
 *     read from it would silently undercount by however many people declined —
 *     and would move whenever consent rates moved, which looks exactly like a
 *     product change and is not one. A session is touched by every signed-in
 *     request regardless of consent.
 *   - The funnel DOES come from analytics, because its top of funnel is
 *     anonymous visitors, who have no session to count. It is therefore a
 *     consenting-visitor funnel, and the ratios are what matter, not the
 *     absolute numbers.
 *   - Logins come from `security_events`, which records every one whether or
 *     not analytics was allowed.
 *
 * Re-running a day is safe and idempotent: the upsert replaces that day's row.
 */
import { sql } from "drizzle-orm";
import type { Database } from "@inkloom/db/client";
import { newId } from "@inkloom/db";
import type { Logger } from "../util/logger";

export interface RollupResult {
  day: string;
  recomputed: boolean;
  durationMs: number;
}

/** The UTC day that just ended, which is what a 03:20 cron should summarise. */
export function previousDay(now: Date = new Date()): string {
  const d = new Date(now.getTime() - 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Summarise one day.
 *
 * Every count is bounded to that day except the running totals and the active
 * windows, which are cumulative and trailing by definition. One statement, so
 * the whole row is a single consistent read rather than a dozen queries that
 * could each see a slightly different database.
 */
export async function rollUpDay(
  db: Database,
  logger: Logger,
  day: string = previousDay(),
): Promise<RollupResult> {
  const startedAt = Date.now();

  await db.execute(sql`
    INSERT INTO daily_metrics (
      id, day,
      users_total, users_verified, signups, verifications, logins,
      dau, wau, mau,
      funnel_visitors, funnel_signup_started, funnel_signup_completed,
      funnel_verified, funnel_activated,
      credits_issued, credits_spent, redemptions,
      emails_sent, emails_failed, support_opened, security_events, rate_limit_blocks,
      database_bytes
    )
    SELECT
      ${newId("dmx")},
      ${day}::date,

      -- Running totals, as at the end of that day.
      (SELECT COUNT(*) FROM users WHERE created_at < (${day}::date + 1) AND status <> 'deleted'),
      (SELECT COUNT(*) FROM users WHERE created_at < (${day}::date + 1)
                                    AND email_verified AND status <> 'deleted'),

      -- Movement during the day.
      (SELECT COUNT(*) FROM users WHERE created_at >= ${day}::date AND created_at < (${day}::date + 1)),
      (SELECT COUNT(*) FROM security_events WHERE type = 'email_verified'
         AND created_at >= ${day}::date AND created_at < (${day}::date + 1)),
      (SELECT COUNT(*) FROM security_events WHERE type = 'login_succeeded'
         AND created_at >= ${day}::date AND created_at < (${day}::date + 1)),

      /*
       * Active users, from sessions rather than analytics — see the note above.
       * Trailing windows END on the day being summarised, so WAU on the 14th
       * covers the 8th to the 14th inclusive.
       */
      (SELECT COUNT(DISTINCT user_id) FROM sessions
        WHERE last_active_at >= ${day}::date AND last_active_at < (${day}::date + 1)),
      (SELECT COUNT(DISTINCT user_id) FROM sessions
        WHERE last_active_at >= (${day}::date - 6) AND last_active_at < (${day}::date + 1)),
      (SELECT COUNT(DISTINCT user_id) FROM sessions
        WHERE last_active_at >= (${day}::date - 29) AND last_active_at < (${day}::date + 1)),

      -- Funnel, consenting visitors only. Same event names the overview uses.
      (SELECT COUNT(DISTINCT anonymous_id) FROM analytics_events WHERE name = 'landing_viewed'
         AND created_at >= ${day}::date AND created_at < (${day}::date + 1)),
      (SELECT COUNT(*) FROM analytics_events WHERE name = 'signup_started'
         AND created_at >= ${day}::date AND created_at < (${day}::date + 1)),
      (SELECT COUNT(*) FROM users WHERE created_at >= ${day}::date AND created_at < (${day}::date + 1)),
      (SELECT COUNT(*) FROM security_events WHERE type = 'email_verified'
         AND created_at >= ${day}::date AND created_at < (${day}::date + 1)),
      (SELECT COUNT(DISTINCT user_id) FROM analytics_events WHERE name = 'dashboard_viewed'
         AND created_at >= ${day}::date AND created_at < (${day}::date + 1)),

      -- Credits. Signs are split so "issued" and "spent" are both positive.
      (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE amount > 0
         AND created_at >= ${day}::date AND created_at < (${day}::date + 1)),
      (SELECT COALESCE(-SUM(amount), 0) FROM credit_ledger WHERE amount < 0
         AND created_at >= ${day}::date AND created_at < (${day}::date + 1)),
      (SELECT COUNT(*) FROM access_code_redemptions
        WHERE created_at >= ${day}::date AND created_at < (${day}::date + 1)),

      -- Reliability.
      (SELECT COUNT(*) FROM email_events WHERE status NOT IN ('failed', 'bounced')
         AND created_at >= ${day}::date AND created_at < (${day}::date + 1)),
      (SELECT COUNT(*) FROM email_events WHERE status IN ('failed', 'bounced')
         AND created_at >= ${day}::date AND created_at < (${day}::date + 1)),
      (SELECT COUNT(*) FROM support_requests
        WHERE created_at >= ${day}::date AND created_at < (${day}::date + 1)),
      (SELECT COUNT(*) FROM security_events
        WHERE created_at >= ${day}::date AND created_at < (${day}::date + 1)),
      (SELECT COALESCE(SUM(count), 0) FROM rate_limit_events WHERE blocked
         AND window_start >= ${day}::date AND window_start < (${day}::date + 1)),

      -- Size, as text: this is a bigint and must not round through a float.
      (SELECT pg_database_size(current_database())::text)

    ON CONFLICT (day) DO UPDATE SET
      users_total             = EXCLUDED.users_total,
      users_verified          = EXCLUDED.users_verified,
      signups                 = EXCLUDED.signups,
      verifications           = EXCLUDED.verifications,
      logins                  = EXCLUDED.logins,
      dau                     = EXCLUDED.dau,
      wau                     = EXCLUDED.wau,
      mau                     = EXCLUDED.mau,
      funnel_visitors         = EXCLUDED.funnel_visitors,
      funnel_signup_started   = EXCLUDED.funnel_signup_started,
      funnel_signup_completed = EXCLUDED.funnel_signup_completed,
      funnel_verified         = EXCLUDED.funnel_verified,
      funnel_activated        = EXCLUDED.funnel_activated,
      credits_issued          = EXCLUDED.credits_issued,
      credits_spent           = EXCLUDED.credits_spent,
      redemptions             = EXCLUDED.redemptions,
      emails_sent             = EXCLUDED.emails_sent,
      emails_failed           = EXCLUDED.emails_failed,
      support_opened          = EXCLUDED.support_opened,
      security_events         = EXCLUDED.security_events,
      rate_limit_blocks       = EXCLUDED.rate_limit_blocks,
      database_bytes          = EXCLUDED.database_bytes,
      updated_at              = now()
  `);

  const result = { day, recomputed: true, durationMs: Date.now() - startedAt };
  logger.info("daily_rollup_complete", result);
  return result;
}

/**
 * Record what this application can measure about its own infrastructure.
 *
 * Deliberately only self-measured figures — database size, connection count,
 * emails actually sent. No provider API is called: those need credentials this
 * deployment does not yet have, and a fetcher that fails every night would be
 * worse than an absent one.
 *
 * The row shape is the same one a provider fetcher will write, so adding Neon
 * CU-hours or Resend volume later is a new caller, not a schema change.
 */
export async function captureSelfMeasuredUsage(
  db: Database,
  logger: Logger,
  day: string = previousDay(),
): Promise<number> {
  const result = await db.execute<{ written: string }>(sql`
    WITH readings AS (
      SELECT 'database'::text AS provider, 'storage_bytes'::text AS metric,
             pg_database_size(current_database())::text AS value, 'bytes'::text AS unit
      UNION ALL
      SELECT 'database', 'connections',
             (SELECT COUNT(*)::text FROM pg_stat_activity WHERE datname = current_database()),
             'connections'
      UNION ALL
      SELECT 'resend', 'emails_sent',
             (SELECT COUNT(*)::text FROM email_events
               WHERE created_at >= ${day}::date AND created_at < (${day}::date + 1)),
             'emails'
    ),
    written AS (
      INSERT INTO provider_metrics (id, provider, metric, day, value, unit, captured_at)
      SELECT
        ${newId("pvm")} || '-' || provider || '-' || metric,
        provider, metric, ${day}::date, value, unit, now()
      FROM readings
      ON CONFLICT (provider, metric, day) DO UPDATE SET
        value = EXCLUDED.value, captured_at = EXCLUDED.captured_at
      RETURNING 1
    )
    SELECT COUNT(*)::text AS written FROM written
  `);

  const written = Number(result.rows[0]?.written ?? 0);
  logger.info("usage_capture_complete", { day, written });
  return written;
}

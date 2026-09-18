import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, tsCol, updatedAt } from "./_shared";

/**
 * Operational telemetry.
 *
 * THE RULE THAT SHAPES ALL THREE TABLES: a request must not write here.
 *
 * The obvious design — one row per request, with its duration and status — is
 * the one thing that cannot be afforded. A signup already costs 15-17 database
 * round trips and a dashboard view 17-29; adding "monitoring" writes to each
 * would make measuring the system the most expensive thing the system does, and
 * the table would grow without bound at exactly the moment traffic spiked.
 *
 * So: the Worker accumulates in memory and flushes an AGGREGATE, at most once
 * every flush interval per isolate. Every column below is additive, and every
 * write is an upsert that adds to what is already there, because several
 * isolates serve traffic at once and each flushes its own partial view.
 *
 * That additive requirement is why latency is stored as a histogram rather than
 * a mean or a stored percentile. Means hide the tail that matters, and
 * percentiles cannot be combined — averaging two isolates' p95 gives a number
 * that is not the p95 of anything. Bucket counts add correctly, and p50/p95/p99
 * are read back off the merged histogram.
 */

/*
 * The latency bucket bounds live in `@inkloom/core/metrics`, not here.
 *
 * They are needed by the BROWSER — the console renders percentiles from these
 * histograms — and anything exported from this package drags the whole Drizzle
 * schema and the Postgres client along with it into the client bundle.
 */

/**
 * Request volume, outcome and latency, by hour.
 *
 * Hourly rather than daily because "when are people actually using this" is one
 * of the questions worth answering, and a daily total cannot answer it. One row
 * per hour per route group is 24 rows a day per group — trivial to store and
 * enough resolution to see a peak.
 */
export const requestMetric = pgTable(
  "request_metrics",
  {
    id: text("id").primaryKey(),
    /** UTC day. Paired with `hour` rather than a timestamp so the upsert key is exact. */
    day: date("day").notNull(),
    /** 0-23, UTC. Rendered in the operator's timezone at display time. */
    hour: integer("hour").notNull(),
    /**
     * A coarse group such as "marketing", "app", "admin", "api.auth".
     *
     * Deliberately NOT the raw path. A path carries ids — /admin/users/usr_123
     * — and putting those here would turn a metrics table into a record of who
     * was looked at and when, which belongs in the audit trail and nowhere else.
     */
    routeGroup: text("route_group").notNull(),

    requests: integer("requests").notNull().default(0),
    /** Outcome classes, kept separate because 429 is operationally distinct from other 4xx. */
    status2xx: integer("status_2xx").notNull().default(0),
    status3xx: integer("status_3xx").notNull().default(0),
    status4xx: integer("status_4xx").notNull().default(0),
    status429: integer("status_429").notNull().default(0),
    status5xx: integer("status_5xx").notNull().default(0),

    /**
     * Cumulative duration, for a mean. Kept alongside the histogram, not
     * instead of it: the mean is the cheap headline and the histogram is what
     * anyone actually diagnoses from.
     */
    durationMsTotal: integer("duration_ms_total").notNull().default(0),
    /** Highest single observation in the hour. The one thing a histogram loses. */
    durationMsMax: integer("duration_ms_max").notNull().default(0),

    /**
     * Cumulative histogram: `{"5": n, "10": n, …, "inf": n}`.
     *
     * Counts of requests at or under each bound, summed across every isolate
     * that reported. Merged additively on upsert by the flush statement.
     */
    latencyBuckets: jsonb("latency_buckets").$type<Record<string, number>>().notNull().default({}),

    /**
     * Typed failure counts: `{"DB_TIMEOUT": 2, "RATE_LIMITED": 47}`.
     *
     * Categories, never messages. A raw error string can carry an address, an
     * id or a fragment of a query, and this table has a longer retention than
     * anything that should hold those. Stack traces go to Sentry.
     */
    errorCodes: jsonb("error_codes").$type<Record<string, number>>().notNull().default({}),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The upsert key. Every flush targets exactly one row.
    uniqueIndex("request_metrics_slot_key").on(t.day, t.hour, t.routeGroup),
    index("request_metrics_day_idx").on(t.day.desc()),
    check("request_metrics_hour_range", sql`${t.hour} >= 0 AND ${t.hour} <= 23`),
    check("request_metrics_non_negative", sql`${t.requests} >= 0 AND ${t.durationMsTotal} >= 0`),
  ],
);

/**
 * One row per day: the business figures, rolled up by the nightly cron.
 *
 * Computed from the source tables rather than counted as events happen, so the
 * request path is untouched and a figure can be recomputed if its definition
 * changes. Every column is nullable-by-omission rather than zero-filled: a day
 * before a metric existed should read as "not measured", not as "zero".
 */
export const dailyMetric = pgTable(
  "daily_metrics",
  {
    id: text("id").primaryKey(),
    day: date("day").notNull(),

    // --- People ---
    usersTotal: integer("users_total"),
    usersVerified: integer("users_verified"),
    signups: integer("signups"),
    verifications: integer("verifications"),
    logins: integer("logins"),
    /** Distinct users with any recorded activity in the window ending this day. */
    dau: integer("dau"),
    wau: integer("wau"),
    mau: integer("mau"),

    // --- Funnel, for the day ---
    funnelVisitors: integer("funnel_visitors"),
    funnelSignupStarted: integer("funnel_signup_started"),
    funnelSignupCompleted: integer("funnel_signup_completed"),
    funnelVerified: integer("funnel_verified"),
    funnelActivated: integer("funnel_activated"),

    // --- Money-shaped ---
    creditsIssued: integer("credits_issued"),
    creditsSpent: integer("credits_spent"),
    redemptions: integer("redemptions"),

    // --- Reliability ---
    emailsSent: integer("emails_sent"),
    emailsFailed: integer("emails_failed"),
    supportOpened: integer("support_opened"),
    securityEvents: integer("security_events"),
    rateLimitBlocks: integer("rate_limit_blocks"),

    // --- Size ---
    /** Whole database, in bytes, at roll-up time. Cheap to read, useful to trend. */
    databaseBytes: text("database_bytes"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("daily_metrics_day_key").on(t.day),
    index("daily_metrics_day_idx").on(t.day.desc()),
  ],
);

/**
 * What each provider says we used, and what that costs.
 *
 * Separate from everything above because it is a different KIND of fact: those
 * tables are measurements this application makes about itself, these are
 * figures fetched from someone else's API and therefore always slightly stale
 * and occasionally missing. Mixing them would make "we have no number" and "the
 * number is zero" indistinguishable, and those mean very different things when
 * the question is whether the free tier is about to run out.
 */
export const providerMetric = pgTable(
  "provider_metrics",
  {
    id: text("id").primaryKey(),
    /** "neon" | "cloudflare" | "resend" | later an AI provider. */
    provider: text("provider").notNull(),
    /** "compute_cu_hours" | "storage_bytes" | "requests" | "emails_sent" | "cost_usd". */
    metric: text("metric").notNull(),
    day: date("day").notNull(),

    /** Text, not a float: these are billing figures and must not pick up binary rounding. */
    value: text("value").notNull(),
    unit: text("unit").notNull(),

    /**
     * The plan's allowance for this metric, when one is known.
     *
     * Stored alongside the reading so a progress bar can be drawn without the
     * dashboard hardcoding a number that changes when the plan does.
     */
    allowance: text("allowance"),

    /** When the provider was asked, which is not the same as the day measured. */
    capturedAt: tsCol("captured_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("provider_metrics_slot_key").on(t.provider, t.metric, t.day),
    index("provider_metrics_day_idx").on(t.day.desc()),
  ],
);

/**
 * A durable record of every scheduled job run.
 *
 * The retention sweep used to leave no trace. It logged to Workers Logs, and
 * only when it actually removed something, so a sweep that deleted nothing and
 * a sweep that never ran produced identical evidence: none. The privacy policy
 * publishes a retention period for every category of data we hold, and the job
 * that keeps that promise could not be shown to have run at all — which is the
 * part an auditor asks about first.
 *
 * One row per completed run, written by the job itself. Two properties matter:
 *
 *   - It is QUERYABLE. "When did retention last succeed?" is a SQL question,
 *     answerable months later, not a log search with a retention period of its
 *     own that is shorter than the thing it is evidence for.
 *   - Its ABSENCE is the alert. A run that dies halfway — the isolate is
 *     killed, the database is unreachable, the cron never fires — writes
 *     nothing, so staleness is detected by the newest row's age rather than by
 *     an error anyone has to remember to raise. Nothing has to go right for the
 *     alarm to work.
 *
 * Not append-only: these rows are operational exhaust, swept by the retention
 * job like anything else. The audit trail lives in `audit_events`.
 */
export const jobRun = pgTable(
  "job_runs",
  {
    id: text("id").primaryKey(),

    /** Stable job key, e.g. "retention_sweep". */
    job: text("job").notNull(),

    startedAt: tsCol("started_at").notNull(),
    finishedAt: tsCol("finished_at").notNull(),

    /**
     * "ok" — every step succeeded.
     * "partial" — the run completed but at least one step failed.
     * "failed" — the run itself threw.
     *
     * "partial" exists because the sweep deliberately continues past a failing
     * step: lock contention on analytics must not mean expired export payloads
     * survive another day. Collapsing that into "ok" would hide a step that has
     * been quietly failing for weeks.
     */
    status: text("status").notNull(),

    durationMs: integer("duration_ms").notNull(),
    removed: integer("removed").notNull().default(0),

    /** Per-step detail, so a chronically failing step is visible without logs. */
    steps: jsonb("steps").$type<Array<Record<string, unknown>>>(),

    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    check("job_runs_status_check", sql`${t.status} IN ('ok', 'partial', 'failed')`),
    // The staleness query is "newest run of this job", so the index carries it.
    index("job_runs_job_finished_idx").on(t.job, t.finishedAt.desc()),
  ],
);

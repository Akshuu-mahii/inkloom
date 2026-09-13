/**
 * Shared pieces for the three analytical console pages.
 *
 * All three read the same `/admin/insights` payload, so the types and the small
 * chart primitives live here rather than being copied. The charts are hand-drawn
 * SVG on purpose: a charting library would be the single largest dependency in
 * the bundle, for four simple shapes, on a page only one person ever opens.
 */
import { percentileFrom } from "@inkloom/core/metrics";

export interface DailyRow {
  day: string;
  users_total: number | null;
  users_verified: number | null;
  signups: number | null;
  verifications: number | null;
  logins: number | null;
  dau: number | null;
  wau: number | null;
  mau: number | null;
  funnel_visitors: number | null;
  funnel_signup_started: number | null;
  funnel_signup_completed: number | null;
  funnel_verified: number | null;
  funnel_activated: number | null;
  credits_issued: number | null;
  credits_spent: number | null;
  redemptions: number | null;
  emails_sent: number | null;
  emails_failed: number | null;
  support_opened: number | null;
  security_events: number | null;
  rate_limit_blocks: number | null;
  database_bytes: string | null;
}

export interface RouteGroupRow {
  route_group: string;
  requests: number;
  status_2xx: number;
  status_4xx: number;
  status_429: number;
  status_5xx: number;
  duration_ms_total: number;
  duration_ms_max: number;
  latency_buckets: Record<string, number>;
  error_codes: Record<string, number>;
}

export interface Insights {
  windowDays: number;
  daily: DailyRow[];
  hourly: Array<{ hour: number; requests: number }>;
  routeGroups: RouteGroupRow[];
  today: {
    signups: number;
    dau: number;
    logins: number;
    emailsSent: number;
    emailsFailed: number;
    requests: number;
    errors: number;
  };
  providers: Array<{
    provider: string;
    metric: string;
    value: string;
    unit: string;
    allowance: string | null;
    day: string;
    captured_at: string;
  }>;
}

/** p50/p95/p99 for a route group, read off its merged histogram. */
export function percentiles(buckets: Record<string, number>) {
  return {
    p50: percentileFrom(buckets, 0.5),
    p95: percentileFrom(buckets, 0.95),
    p99: percentileFrom(buckets, 0.99),
  };
}

/**
 * Render a latency figure.
 *
 * `-1` means the tail ran past the largest bucket, and `null` means there was
 * no traffic at all. Those are different facts and are shown differently —
 * printing "0ms" for either would be a lie that reads as excellent performance.
 */
export function latencyLabel(value: number | null): string {
  if (value === null) return "—";
  if (value === -1) return ">5s";
  return `≤${value}ms`;
}

export function formatBytes(bytes: string | number | null): string {
  const n = typeof bytes === "string" ? Number(bytes) : bytes;
  if (!n || Number.isNaN(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * A bar chart.
 *
 * Labelled by value rather than by an axis, because these series are short and
 * a reader wants the number, not to estimate it off a gridline. An all-zero
 * series renders flat rather than dividing by zero into NaN heights.
 */
export function BarChart({
  data,
  height = 120,
  label,
  highlight,
}: {
  data: Array<{ label: string; value: number }>;
  height?: number;
  label: string;
  /** Index to mark as the peak, when one is worth calling out. */
  highlight?: number;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <figure className="chart" aria-label={label}>
      <div className="chart-bars" style={{ height }}>
        {data.map((d, i) => (
          <div key={d.label} className="chart-col" title={`${d.label}: ${d.value}`}>
            <div
              className={`chart-bar${i === highlight ? " is-peak" : ""}`}
              style={{ height: `${Math.max((d.value / max) * 100, d.value > 0 ? 2 : 0)}%` }}
            />
            <span className="chart-tick">{d.label}</span>
          </div>
        ))}
      </div>
      <figcaption className="chart-caption">
        {label} · peak {max.toLocaleString("en-GB")}
      </figcaption>
      <style>{`
        .chart { margin: 0; }
        .chart-bars {
          display: flex; align-items: flex-end; gap: 2px;
          border-bottom: 1px solid var(--color-rule); padding-bottom: 0;
        }
        .chart-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end;
          align-items: center; height: 100%; min-width: 0; }
        .chart-bar { width: 100%; background: var(--color-ink); opacity: .28; border-radius: 1px 1px 0 0;
          transition: opacity .15s; }
        .chart-col:hover .chart-bar { opacity: .5; }
        .chart-bar.is-peak { opacity: .85; }
        .chart-tick { font-size: .5625rem; color: var(--color-faint); margin-top: 4px;
          white-space: nowrap; overflow: hidden; }
        .chart-caption { font-size: var(--text-fine); color: var(--color-muted); margin-top: .75rem; }
        @media (prefers-reduced-motion: reduce) { .chart-bar { transition: none; } }
      `}</style>
    </figure>
  );
}

/**
 * A funnel, drawn as proportional bars with drop-off between steps.
 *
 * The drop-off is the point of the chart, so it is stated as a number rather
 * than left to be inferred from two bar widths.
 */
export function Funnel({ steps }: { steps: Array<{ label: string; value: number }> }) {
  const top = steps[0]?.value ?? 0;

  return (
    <div className="funnel">
      {steps.map((step, i) => {
        const previous = i > 0 ? (steps[i - 1]?.value ?? 0) : null;
        const share = top > 0 ? (step.value / top) * 100 : 0;
        const dropOff =
          previous && previous > 0 ? Math.round(((previous - step.value) / previous) * 100) : null;

        return (
          <div key={step.label} className="funnel-step">
            <div className="funnel-head">
              <span>{step.label}</span>
              <span className="funnel-value">
                {step.value.toLocaleString("en-GB")}
                {top > 0 && <span className="funnel-share"> · {Math.round(share)}%</span>}
              </span>
            </div>
            <div className="funnel-track">
              <div className="funnel-fill" style={{ width: `${Math.max(share, 1)}%` }} />
            </div>
            {dropOff !== null && dropOff > 0 && (
              <p className="funnel-drop">−{dropOff}% from the step above</p>
            )}
          </div>
        );
      })}
      <style>{`
        .funnel { display: flex; flex-direction: column; gap: 1rem; }
        .funnel-head { display: flex; justify-content: space-between; align-items: baseline;
          font-size: var(--text-fine); margin-bottom: .375rem; }
        .funnel-value { font-variant-numeric: tabular-nums; font-weight: 500; }
        .funnel-share { color: var(--color-muted); font-weight: 400; }
        .funnel-track { height: 8px; background: var(--color-rule); border-radius: 2px; overflow: hidden; }
        .funnel-fill { height: 100%; background: var(--color-ink); opacity: .75; }
        .funnel-drop { margin: .3125rem 0 0; font-size: .6875rem; color: var(--color-faint); }
      `}</style>
    </div>
  );
}

/** A labelled usage meter, for a quota with a known allowance. */
export function Meter({
  label,
  value,
  allowance,
  display,
}: {
  label: string;
  value: number;
  allowance: number | null;
  display: string;
}) {
  const share = allowance && allowance > 0 ? Math.min((value / allowance) * 100, 100) : null;
  // Amber at three quarters, red at ninety: early enough to act, not so early
  // that the console cries wolf every week.
  const tone = share === null ? "none" : share >= 90 ? "stop" : share >= 75 ? "warn" : "ok";

  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-value">{display}</span>
      </div>
      {share !== null && (
        <>
          <div className="meter-track">
            <div className={`meter-fill tone-${tone}`} style={{ width: `${share}%` }} />
          </div>
          <p className="meter-note">{Math.round(share)}% of the plan allowance</p>
        </>
      )}
      <style>{`
        .meter-head { display: flex; justify-content: space-between; align-items: baseline;
          font-size: var(--text-fine); }
        .meter-value { font-variant-numeric: tabular-nums; font-weight: 500; }
        .meter-track { height: 6px; background: var(--color-rule); border-radius: 2px;
          overflow: hidden; margin-top: .5rem; }
        .meter-fill { height: 100%; background: var(--color-ink); opacity: .7; }
        .meter-fill.tone-warn { background: #8F5E10; opacity: 1; }
        .meter-fill.tone-stop { background: #9E3226; opacity: 1; }
        .meter-note { margin: .375rem 0 0; font-size: .6875rem; color: var(--color-faint); }
      `}</style>
    </div>
  );
}

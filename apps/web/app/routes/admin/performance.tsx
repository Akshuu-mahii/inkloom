import type { Route } from "./+types/performance";
import { call } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Empty, Notice, PageHeader, Pill, Stat } from "../../components/ui";
import { latencyLabel, percentiles, type Insights, type RouteGroupRow } from "./insights-shared";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Performance",
    description: "Latency, errors and what is breaking.",
    path: location.pathname,
    noindex: true,
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  const result = await call<Insights>("/admin/insights?days=7", { request });
  return { insights: result.data, error: result.error?.message ?? null };
}

/** Every typed failure across all route groups, most frequent first. */
function errorTotals(groups: RouteGroupRow[]): Array<{ code: string; count: number }> {
  const totals = new Map<string, number>();
  for (const group of groups) {
    for (const [code, count] of Object.entries(group.error_codes ?? {})) {
      totals.set(code, (totals.get(code) ?? 0) + count);
    }
  }
  return [...totals.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);
}

export default function AdminPerformance({ loaderData }: Route.ComponentProps) {
  const { insights, error } = loaderData;

  if (error || !insights) {
    return (
      <>
        <PageHeader title="Performance" description="Latency, errors and what is breaking." />
        <Notice tone="critical">{error ?? "Could not load performance data."}</Notice>
      </>
    );
  }

  const groups = insights.routeGroups;
  const totalRequests = groups.reduce((sum, g) => sum + g.requests, 0);
  const totalErrors = groups.reduce((sum, g) => sum + g.status_5xx, 0);
  const totalLimited = groups.reduce((sum, g) => sum + g.status_429, 0);

  // One histogram across everything, for the headline percentiles.
  const allBuckets: Record<string, number> = {};
  for (const group of groups) {
    for (const [bound, count] of Object.entries(group.latency_buckets ?? {})) {
      allBuckets[bound] = (allBuckets[bound] ?? 0) + count;
    }
  }
  const overall = percentiles(allBuckets);
  const errors = errorTotals(groups);

  if (totalRequests === 0) {
    return (
      <>
        <PageHeader title="Performance" description="Latency, errors and what is breaking." />
        <Empty title="No traffic recorded yet">
          Metrics are collected in memory and flushed about once a minute, so a brand-new deployment
          takes a few minutes to show anything.
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Performance"
        description={`Latency, errors and what is breaking. Last ${insights.windowDays} days.`}
      />

      <section className="admin-section">
        <h2 className="admin-h2">Overall</h2>
        <div className="stat-grid">
          <Stat value={latencyLabel(overall.p50)} label="p50 latency" />
          <Stat value={latencyLabel(overall.p95)} label="p95 latency" />
          <Stat value={latencyLabel(overall.p99)} label="p99 latency" />
          <Stat
            value={totalRequests > 0 ? `${((totalErrors / totalRequests) * 100).toFixed(2)}%` : "—"}
            label="5xx rate"
            tone={totalErrors > 0 ? "loop" : undefined}
          />
        </div>
        <p className="admin-note">
          Latency is stored as a histogram, so these are bucket bounds rather than exact values:{" "}
          <strong>{latencyLabel(overall.p95)}</strong> means 95% of requests finished at or under
          that. That is deliberate — percentiles from several Worker isolates cannot be averaged
          into a meaningful number, but bucket counts add exactly.
        </p>
      </section>

      <section className="admin-section">
        <h2 className="admin-h2">By area</h2>
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Area</th>
                <th className="num">Requests</th>
                <th className="num">p50</th>
                <th className="num">p95</th>
                <th className="num">p99</th>
                <th className="num">Slowest</th>
                <th className="num">4xx</th>
                <th className="num">429</th>
                <th className="num">5xx</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const p = percentiles(group.latency_buckets ?? {});
                return (
                  <tr key={group.route_group}>
                    <td>
                      <code>{group.route_group}</code>
                    </td>
                    <td className="num">{group.requests.toLocaleString("en-GB")}</td>
                    <td className="num">{latencyLabel(p.p50)}</td>
                    <td className="num">{latencyLabel(p.p95)}</td>
                    <td className="num">{latencyLabel(p.p99)}</td>
                    <td className="num">{group.duration_ms_max}ms</td>
                    <td className="num">{group.status_4xx || "—"}</td>
                    <td className="num">{group.status_429 || "—"}</td>
                    <td className="num">
                      {group.status_5xx > 0 ? <strong>{group.status_5xx}</strong> : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="admin-note">
          &ldquo;Slowest&rdquo; is the single worst request in the window — the one figure a
          histogram cannot recover, so it is kept separately. A high p99 with a normal p95 is a tail
          problem; a high p50 is everyone.
        </p>
      </section>

      <section className="admin-section">
        <h2 className="admin-h2">What is failing</h2>
        {errors.length === 0 ? (
          <Empty title="No typed failures recorded">
            Nothing returned an error envelope in this window.
          </Empty>
        ) : (
          <ul className="error-list">
            {errors.map(({ code, count }) => (
              <li key={code}>
                <Pill
                  tone={
                    code === "RATE_LIMITED"
                      ? "caution"
                      : code === "INTERNAL_ERROR"
                        ? "critical"
                        : "neutral"
                  }
                >
                  {code}
                </Pill>
                <span className="error-count">{count.toLocaleString("en-GB")}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="admin-note">
          Categories, never messages — a raw error string can carry an address, an id or part of a
          query, and this table is kept far longer than anything that should hold those. Stack
          traces go to Sentry.{" "}
          {totalLimited > 0 && (
            <>
              {" "}
              <strong>{totalLimited.toLocaleString("en-GB")}</strong> requests were rate-limited; a
              sudden jump there usually means someone is probing rather than that the limits are
              wrong.
            </>
          )}
        </p>
      </section>

      <style>{`
        .admin-section { margin-bottom: 2.75rem; }
        .admin-h2 { font-size: var(--text-h3); margin: 0 0 1rem; }
        .admin-note { margin: 1rem 0 0; color: var(--color-muted); font-size: var(--text-fine);
          max-width: 64ch; }
        .stat-grid { display: grid; gap: 1rem;
          grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); }
        .table-scroll { overflow-x: auto; }
        .admin-table { width: 100%; border-collapse: collapse; font-size: var(--text-fine);
          min-width: 44rem; }
        .admin-table th { text-align: left; padding: .5rem .75rem; color: var(--color-muted);
          border-bottom: 1px solid var(--color-rule); font-weight: 500; white-space: nowrap; }
        .admin-table td { padding: .625rem .75rem; border-bottom: 1px solid var(--color-hairline); }
        .admin-table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .error-list { list-style: none; margin: 0; padding: 0; display: flex;
          flex-direction: column; gap: .5rem; max-width: 26rem; }
        .error-list li { display: flex; justify-content: space-between; align-items: center;
          gap: 1rem; padding-bottom: .5rem; border-bottom: 1px solid var(--color-hairline); }
        .error-count { font-variant-numeric: tabular-nums; font-weight: 500; }
      `}</style>
    </>
  );
}

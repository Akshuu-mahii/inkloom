import type { Route } from "./+types/activity";
import { call } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Empty, Notice, PageHeader, Stat } from "../../components/ui";
import { BarChart, Funnel, type Insights } from "./insights-shared";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Activity",
    description: "Who is using Inkloom, and when.",
    path: location.pathname,
    noindex: true,
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  const result = await call<Insights>("/admin/insights?days=30", { request });
  return { insights: result.data, error: result.error?.message ?? null };
}

/** Peak hour, or null when there is no traffic at all yet. */
function peakHour(hourly: Insights["hourly"]): { hour: number; requests: number } | null {
  if (hourly.length === 0) return null;
  return hourly.reduce((best, h) => (h.requests > best.requests ? h : best), hourly[0]!);
}

export default function AdminActivity({ loaderData }: Route.ComponentProps) {
  const { insights, error } = loaderData;

  if (error || !insights) {
    return (
      <>
        <PageHeader title="Activity" description="Who is using Inkloom, and when." />
        <Notice tone="critical">{error ?? "Could not load activity."}</Notice>
      </>
    );
  }

  const latest = insights.daily.at(-1);
  const peak = peakHour(insights.hourly);

  /*
   * Every hour of the day, not only the hours that saw traffic.
   *
   * The query returns rows only for hours with requests, so rendering it
   * directly would draw a chart with gaps closed up — 03:00 sitting next to
   * 14:00 and looking adjacent. A quiet hour is a real observation and has to
   * occupy its own slot for the shape to mean anything.
   */
  const byHour = Array.from({ length: 24 }, (_, hour) => ({
    label: String(hour).padStart(2, "0"),
    value: insights.hourly.find((h) => h.hour === hour)?.requests ?? 0,
  }));

  const signupSeries = insights.daily.map((d) => ({
    label: d.day.slice(8, 10),
    value: d.signups ?? 0,
  }));
  const dauSeries = insights.daily.map((d) => ({ label: d.day.slice(8, 10), value: d.dau ?? 0 }));

  return (
    <>
      <PageHeader
        title="Activity"
        description={`Who is using Inkloom, and when. Last ${insights.windowDays} days.`}
      />

      <section className="admin-section">
        <h2 className="admin-h2">Today, so far</h2>
        <div className="stat-grid">
          <Stat value={insights.today.dau} label="Active users" />
          <Stat value={insights.today.signups} label="Signups" />
          <Stat value={insights.today.logins} label="Logins" />
          <Stat value={insights.today.requests.toLocaleString("en-GB")} label="Requests" />
        </div>
        <p className="admin-note">
          Computed live. Everything below comes from the nightly roll-up and therefore ends
          yesterday.
        </p>
      </section>

      <section className="admin-section">
        <h2 className="admin-h2">Returning users</h2>
        {latest ? (
          <div className="stat-grid">
            <Stat value={latest.dau ?? 0} label="Daily active" />
            <Stat value={latest.wau ?? 0} label="Weekly active" />
            <Stat value={latest.mau ?? 0} label="Monthly active" />
            <Stat
              value={
                latest.mau && latest.mau > 0
                  ? `${Math.round(((latest.dau ?? 0) / latest.mau) * 100)}%`
                  : "—"
              }
              label="DAU / MAU"
            />
          </div>
        ) : (
          <Empty title="No roll-up yet">
            The nightly job has not run. Until it does, only today's live figures are available.
          </Empty>
        )}
        <p className="admin-note">
          Counted from sessions, not analytics — so someone who declined the cookie notice is still
          counted as active. DAU/MAU is the stickiness ratio: how much of the monthly audience shows
          up on any given day.
        </p>
      </section>

      <section className="admin-section">
        <h2 className="admin-h2">When people are active</h2>
        <BarChart
          data={byHour}
          label="Requests by hour of day (UTC)"
          highlight={peak ? byHour.findIndex((b) => Number(b.label) === peak.hour) : undefined}
        />
        {peak && peak.requests > 0 && (
          <p className="admin-note">
            Busiest hour is <strong>{String(peak.hour).padStart(2, "0")}:00 UTC</strong> with{" "}
            {peak.requests.toLocaleString("en-GB")} requests across the window. Deploys and the
            nightly job are best kept well away from it.
          </p>
        )}
      </section>

      <section className="admin-section">
        <h2 className="admin-h2">Signups and active users</h2>
        <div className="chart-pair">
          <BarChart data={signupSeries} label="Signups per day" />
          <BarChart data={dauSeries} label="Daily active users" />
        </div>
      </section>

      <section className="admin-section">
        <h2 className="admin-h2">Signup funnel</h2>
        {latest ? (
          <Funnel
            steps={[
              { label: "Landing viewed", value: latest.funnel_visitors ?? 0 },
              { label: "Signup started", value: latest.funnel_signup_started ?? 0 },
              { label: "Account created", value: latest.funnel_signup_completed ?? 0 },
              { label: "Email verified", value: latest.funnel_verified ?? 0 },
              { label: "Dashboard opened", value: latest.funnel_activated ?? 0 },
            ]}
          />
        ) : (
          <Empty title="No funnel yet">Waiting on the first nightly roll-up.</Empty>
        )}
        <p className="admin-note">
          The first two steps come from analytics and therefore only count visitors who accepted the
          cookie notice; the rest come from the database and count everyone. Read the ratios, not
          the absolute numbers — and expect the step into &ldquo;account created&rdquo; to look
          better than it is for that reason.
        </p>
      </section>

      <style>{`
        .admin-section { margin-bottom: 2.75rem; }
        .admin-h2 { font-size: var(--text-h3); margin: 0 0 1rem; }
        .admin-note { margin: 1rem 0 0; color: var(--color-muted); font-size: var(--text-fine);
          max-width: 62ch; }
        .stat-grid { display: grid; gap: 1rem;
          grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); }
        .chart-pair { display: grid; gap: 2rem; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); }
      `}</style>
    </>
  );
}

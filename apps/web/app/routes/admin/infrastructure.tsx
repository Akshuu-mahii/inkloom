import type { Route } from "./+types/infrastructure";
import { call } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Empty, Notice, PageHeader, Stat } from "../../components/ui";
import { BarChart, Meter, formatBytes, type Insights } from "./insights-shared";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Infrastructure",
    description: "Usage, growth and what it costs.",
    path: location.pathname,
    noindex: true,
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  const result = await call<Insights>("/admin/insights?days=30", { request });
  return { insights: result.data, error: result.error?.message ?? null };
}

/**
 * What the providers charge, as at September 2026.
 *
 * Held here rather than in the database because they are facts about the
 * outside world, not measurements — and because a stale hardcoded price is
 * obvious when the page says where it came from, whereas a stale price in a
 * table looks like data. Re-check before relying on a figure.
 */
const PRICING = {
  workersMonthly: 5,
  resendFreeDailyEmails: 100,
  neonFreeStorageBytes: 0.5 * 1024 * 1024 * 1024,
} as const;

export default function AdminInfrastructure({ loaderData }: Route.ComponentProps) {
  const { insights, error } = loaderData;

  if (error || !insights) {
    return (
      <>
        <PageHeader title="Infrastructure" description="Usage, growth and what it costs." />
        <Notice tone="critical">{error ?? "Could not load infrastructure data."}</Notice>
      </>
    );
  }

  const _reading = (provider: string, metric: string) =>
    insights.providers.find((p) => p.provider === provider && p.metric === metric);

  /*
   * "Right now" must mean right now.
   *
   * These three came from the nightly roll-up, so the console read "0 Users" for
   * a day after the first person signed up — under a heading promising the
   * present, beside a storage figure that was equally stale but looked
   * plausible. The API measures all three at request time instead.
   *
   * `provider_metrics` is still read below, because the daily readings are what
   * the growth trend is built from; they just do not belong in this card.
   */
  const storageBytes = insights.now.databaseBytes;
  const connectionCount = insights.now.connections;
  const users = insights.now.usersTotal;

  /*
   * Storage growth from the roll-up's own history.
   *
   * Only meaningful once there are two days to compare, so it is shown as "not
   * enough history yet" rather than as a confident zero — a flat line here
   * would read as "nothing is growing", which is a different claim.
   */
  const withStorage = insights.daily.filter((d) => d.database_bytes);
  const first = withStorage[0];
  const last = withStorage.at(-1);
  const growthPerDay =
    withStorage.length >= 2 && first && last
      ? (Number(last.database_bytes) - Number(first.database_bytes)) / (withStorage.length - 1)
      : null;

  const emailSeries = insights.daily.map((d) => ({
    label: d.day.slice(8, 10),
    value: d.emails_sent ?? 0,
  }));
  const peakDailyEmails = Math.max(...emailSeries.map((e) => e.value), 0);

  return (
    <>
      <PageHeader
        title="Infrastructure"
        description={`Usage, growth and what it costs. Last ${insights.windowDays} days.`}
      />

      <section className="admin-section">
        <h2 className="admin-h2">Right now</h2>
        <div className="stat-grid">
          <Stat value={formatBytes(storageBytes)} label="Database size" />
          <Stat value={connectionCount.toLocaleString("en-GB")} label="Connections" />
          <Stat value={users.toLocaleString("en-GB")} label="Users" />
          <Stat
            value={users > 0 ? formatBytes(storageBytes / users) : "—"}
            label="Storage per user"
          />
        </div>
      </section>

      <section className="admin-section">
        <h2 className="admin-h2">Against the free tiers</h2>
        <div className="meter-grid">
          <Meter
            label="Neon storage"
            value={storageBytes}
            allowance={PRICING.neonFreeStorageBytes}
            display={`${formatBytes(storageBytes)} of ${formatBytes(PRICING.neonFreeStorageBytes)}`}
          />
          <Meter
            label="Resend, busiest day"
            value={peakDailyEmails}
            allowance={PRICING.resendFreeDailyEmails}
            display={`${peakDailyEmails} of ${PRICING.resendFreeDailyEmails}/day`}
          />
        </div>
        <p className="admin-note">
          The Resend meter is the one to watch: its free tier caps at{" "}
          {PRICING.resendFreeDailyEmails} emails per <em>day</em>, and a signup sends about two, so
          roughly {Math.floor(PRICING.resendFreeDailyEmails / 2)} signups a day exhausts it. The
          failure is invisible from outside — the page still says the mail is on its way.
        </p>
      </section>

      <section className="admin-section">
        <h2 className="admin-h2">Growth</h2>
        {growthPerDay === null ? (
          <Empty title="Not enough history yet">
            Storage growth needs at least two nightly roll-ups to compare. Check back tomorrow.
          </Empty>
        ) : (
          <div className="stat-grid">
            <Stat value={formatBytes(growthPerDay)} label="Growth per day" />
            <Stat value={formatBytes(growthPerDay * 30)} label="Projected per month" />
            <Stat
              value={
                growthPerDay > 0
                  ? `${Math.round((PRICING.neonFreeStorageBytes - storageBytes) / growthPerDay)} days`
                  : "—"
              }
              label="Until the free tier fills"
            />
          </div>
        )}
      </section>

      <section className="admin-section">
        <h2 className="admin-h2">Email volume</h2>
        <BarChart data={emailSeries} label="Emails sent per day" />
      </section>

      <section className="admin-section">
        <h2 className="admin-h2">What is not measured here</h2>
        <Notice tone="info">
          <p style={{ margin: 0 }}>
            Everything above is measured by this application about itself. Figures that only the
            providers know — Neon CU-hours, Cloudflare Worker requests and CPU, Resend delivery and
            bounce rates — need API credentials that are not configured yet, and are deliberately
            absent rather than estimated. The table they will fill already exists, so adding them is
            a new fetcher and not a schema change.
          </p>
          <p style={{ margin: "0.75rem 0 0" }}>
            <strong>CU-hours are the figure that decides your Neon bill</strong>, and it cannot be
            derived from anything here — check the Neon dashboard directly in your first week.
          </p>
        </Notice>
      </section>

      <style>{`
        .admin-section { margin-bottom: 2.75rem; }
        .admin-h2 { font-size: var(--text-h3); margin: 0 0 1rem; }
        .admin-note { margin: 1rem 0 0; color: var(--color-muted); font-size: var(--text-fine);
          max-width: 64ch; }
        .stat-grid { display: grid; gap: 1rem;
          grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); }
        .meter-grid { display: grid; gap: 1.75rem;
          grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
      `}</style>
    </>
  );
}

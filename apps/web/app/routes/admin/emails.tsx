import type { Route } from "./+types/emails";
import { call } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Empty, Notice, PageHeader, Pill, Stat, formatDate } from "../../components/ui";
import { BarChart } from "./insights-shared";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Emails",
    description: "Delivery, bounces and failures.",
    path: location.pathname,
    noindex: true,
  });
}

interface EmailReport {
  windowDays: number;
  totals: {
    total?: string;
    delivered?: string;
    failed?: string;
    queued?: string;
    today?: string;
  };
  byTemplate: Array<{
    template: string;
    total: string;
    delivered: string;
    queued: string;
    bounced: string;
    complained: string;
    failed: string;
  }>;
  daily: Array<{ day: string; sent: string; failed: string }>;
  failures: Array<{
    id: string;
    template: string;
    to_email: string | null;
    status: string;
    error: string | null;
    created_at: string;
  }>;
}

export async function loader({ request }: Route.LoaderArgs) {
  const result = await call<EmailReport>("/admin/emails?days=30", { request });
  return { report: result.data, error: result.error?.message ?? null };
}

/** Resend's free tier caps per DAY, which is the limit that actually bites. */
const FREE_DAILY_CAP = 100;

export default function AdminEmails({ loaderData }: Route.ComponentProps) {
  const { report, error } = loaderData;

  if (error || !report) {
    return (
      <>
        <PageHeader title="Emails" description="Delivery, bounces and failures." />
        <Notice tone="critical">{error ?? "Could not load email data."}</Notice>
      </>
    );
  }

  const n = (v: string | undefined) => Number(v ?? 0);
  const total = n(report.totals.total);
  const delivered = n(report.totals.delivered);
  const failed = n(report.totals.failed);
  const deliveryRate = total > 0 ? (delivered / total) * 100 : null;

  const volume = report.daily.map((d) => ({ label: d.day.slice(8, 10), value: Number(d.sent) }));
  const busiestDay = Math.max(...volume.map((v) => v.value), 0);

  return (
    <>
      <PageHeader
        title="Emails"
        description={`Delivery, bounces and failures. Last ${report.windowDays} days.`}
      />

      {failed > 0 && (
        <Notice tone="critical">
          <strong>
            {failed.toLocaleString("en-GB")} message{failed === 1 ? "" : "s"} did not arrive.
          </strong>{" "}
          Nothing retries automatically — a failed send is recorded and then left alone. Until a
          retry queue exists, the list below is the only place these surface, and the people
          affected were told their mail was on its way.
        </Notice>
      )}

      <section className="admin-section">
        <h2 className="admin-h2">Delivery</h2>
        <div className="stat-grid">
          <Stat value={total.toLocaleString("en-GB")} label="Sent in window" />
          <Stat
            value={deliveryRate === null ? "—" : `${deliveryRate.toFixed(1)}%`}
            label="Delivered"
          />
          <Stat value={failed} label="Failed or bounced" tone={failed > 0 ? "loop" : undefined} />
          <Stat value={n(report.totals.today)} label="Today" />
        </div>
        <p className="admin-note">
          &ldquo;Delivered&rdquo; means the provider accepted and did not report a bounce. True
          delivery confirmation needs the Resend API, which is not wired up yet — so read this as
          &ldquo;we did not hear that it failed&rdquo;, which is weaker.
        </p>
      </section>

      <section className="admin-section">
        <h2 className="admin-h2">Volume</h2>
        <BarChart data={volume} label="Emails sent per day" />
        <p className="admin-note">
          Busiest day in this window sent <strong>{busiestDay}</strong>. The Resend free tier allows{" "}
          {FREE_DAILY_CAP} a day
          {busiestDay > FREE_DAILY_CAP * 0.75 && (
            <>
              {" "}
              — <strong>you are within reach of it</strong>
            </>
          )}
          . A signup sends about two, so roughly {Math.floor(FREE_DAILY_CAP / 2)} signups a day
          exhausts the allowance.
        </p>
      </section>

      <section className="admin-section">
        <h2 className="admin-h2">By message type</h2>
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Template</th>
                <th className="num">Sent</th>
                <th className="num">Delivered</th>
                <th className="num">Queued</th>
                <th className="num">Bounced</th>
                <th className="num">Failed</th>
              </tr>
            </thead>
            <tbody>
              {report.byTemplate.map((t) => {
                const bad = Number(t.failed) + Number(t.bounced);
                return (
                  <tr key={t.template}>
                    <td>
                      <code>{t.template}</code>
                    </td>
                    <td className="num">{Number(t.total).toLocaleString("en-GB")}</td>
                    <td className="num">{Number(t.delivered).toLocaleString("en-GB")}</td>
                    <td className="num">{Number(t.queued) || "—"}</td>
                    <td className="num">{Number(t.bounced) || "—"}</td>
                    <td className="num">
                      {bad > 0 ? <strong>{Number(t.failed) || "—"}</strong> : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="admin-note">
          Ordered by failures first. A verification email failing matters far more than a welcome
          email failing — the first blocks an account, the second is a courtesy.
        </p>
      </section>

      <section className="admin-section">
        <h2 className="admin-h2">Recent failures</h2>
        {report.failures.length === 0 ? (
          <Empty title="Nothing failed">
            No message bounced, failed or drew a complaint in this window.
          </Empty>
        ) : (
          <div className="table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Template</th>
                  <th>Recipient</th>
                  <th>Status</th>
                  <th>Provider said</th>
                </tr>
              </thead>
              <tbody>
                {report.failures.map((f) => (
                  <tr key={f.id}>
                    <td className="nowrap">{formatDate(f.created_at, true)}</td>
                    <td>
                      <code>{f.template}</code>
                    </td>
                    <td>{f.to_email ?? "—"}</td>
                    <td>
                      <Pill tone={f.status === "complained" ? "caution" : "critical"}>
                        {f.status}
                      </Pill>
                    </td>
                    <td className="reason">{f.error ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
          min-width: 38rem; }
        .admin-table th { text-align: left; padding: .5rem .75rem; color: var(--color-muted);
          border-bottom: 1px solid var(--color-rule); font-weight: 500; white-space: nowrap; }
        .admin-table td { padding: .625rem .75rem; border-bottom: 1px solid var(--color-hairline);
          vertical-align: top; }
        .admin-table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .admin-table .nowrap { white-space: nowrap; }
        .admin-table .reason { color: var(--color-muted); max-width: 24rem; }
      `}</style>
    </>
  );
}

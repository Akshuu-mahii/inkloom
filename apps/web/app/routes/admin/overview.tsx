import { Link } from "react-router";
import type { Route } from "./+types/overview";
import { call } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Notice, PageHeader, Pill, Stat, formatCredits, formatRelative } from "../../components/ui";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Admin overview",
    description: "Platform health.",
    path: location.pathname,
    noindex: true,
  });
}

interface Overview {
  users: {
    total: number;
    verified: number;
    suspended: number;
    signupsToday: number;
    signupsWeek: number;
    signupsMonth: number;
  };
  sessions: { active: number };
  credits: {
    granted: number;
    outstanding: number;
    byCampaign: Array<{
      campaignId: string;
      name: string;
      redemptions: number;
      creditAmount: number;
      status: string;
    }>;
  };
  redemptions: { successful: number; blocked: number; activeCampaigns: number };
  operations: {
    emailFailures: number;
    openSupport: number;
    criticalSecurityEvents: number;
    status: string;
  };
  funnel: {
    visitors: number;
    signupStarted: number;
    signupCompleted: number;
    emailVerified: number;
    codeRedeemed: number;
    dashboardActivated: number;
  };
  recentSecurityEvents: Array<{
    id: string;
    type: string;
    severity: string;
    targetEmail: string | null;
    createdAt: string;
  }>;
  recentAdminActions: Array<{
    id: string;
    action: string;
    actorId: string | null;
    targetType: string | null;
    reason: string | null;
    createdAt: string;
  }>;
}

export async function loader({ request }: Route.LoaderArgs) {
  const result = await call<Overview>("/admin/overview", { request });
  return { overview: result.data, error: result.error };
}

export default function AdminOverview({ loaderData }: Route.ComponentProps) {
  const o = loaderData.overview;

  if (!o) {
    return (
      <>
        <PageHeader title="Overview" />
        <Notice tone="critical">
          {loaderData.error?.message ?? "Could not load the overview."}
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Overview"
        description="Platform health and the early-access funnel."
        actions={
          <Pill tone={o.operations.status === "healthy" ? "positive" : "caution"}>
            {o.operations.status === "healthy" ? "All systems normal" : "Needs attention"}
          </Pill>
        }
      />

      <section className="stat-row">
        <Stat value={o.users.total.toLocaleString("en-GB")} label="Total users" />
        <Stat value={o.users.verified.toLocaleString("en-GB")} label="Verified" />
        <Stat value={o.users.signupsToday} label="Signups today" />
        <Stat value={o.users.signupsWeek} label="This week" />
        <Stat value={o.sessions.active.toLocaleString("en-GB")} label="Active sessions" />
        <Stat
          value={o.users.suspended}
          label="Suspended"
          tone={o.users.suspended > 0 ? "loop" : "muted"}
        />
      </section>

      <section className="stat-row" style={{ marginTop: "2.5rem" }}>
        <Stat value={formatCredits(o.credits.granted)} label="Credits granted" tone="loop" />
        <Stat value={formatCredits(o.credits.outstanding)} label="Credits outstanding" />
        <Stat value={o.redemptions.successful} label="Successful redemptions" />
        <Stat
          value={o.redemptions.blocked}
          label="Blocked attempts (7d)"
          tone={o.redemptions.blocked > 0 ? "loop" : "muted"}
        />
        <Stat
          value={o.operations.emailFailures}
          label="Email failures (24h)"
          tone={o.operations.emailFailures > 0 ? "loop" : "muted"}
        />
        <Stat value={o.operations.openSupport} label="Open support" />
      </section>

      {/* --- Funnel: genuinely a sequence, so it is ordered and numbered --- */}
      <section style={{ marginTop: "3rem" }}>
        <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1.25rem" }}>Early-access funnel</h2>
        <Funnel
          steps={[
            { label: "Visitors", value: o.funnel.visitors },
            { label: "Signup started", value: o.funnel.signupStarted },
            { label: "Signup completed", value: o.funnel.signupCompleted },
            { label: "Email verified", value: o.funnel.emailVerified },
            { label: "Code redeemed", value: o.funnel.codeRedeemed },
            { label: "Dashboard activated", value: o.funnel.dashboardActivated },
          ]}
        />
      </section>

      <div className="admin-grid" style={{ marginTop: "3rem" }}>
        <section>
          <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1rem" }}>Credits by campaign</h2>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Campaign</th>
                  <th scope="col">Status</th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Redemptions
                  </th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Credits issued
                  </th>
                </tr>
              </thead>
              <tbody>
                {o.credits.byCampaign.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ color: "var(--color-muted)" }}>
                      No campaigns yet.
                    </td>
                  </tr>
                ) : (
                  o.credits.byCampaign.map((c) => (
                    <tr key={c.campaignId}>
                      <td>
                        <Link to={`/admin/access-codes/${c.campaignId}`}>{c.name}</Link>
                      </td>
                      <td>
                        <Pill
                          tone={
                            c.status === "enabled"
                              ? "positive"
                              : c.status === "revoked"
                                ? "critical"
                                : "caution"
                          }
                        >
                          {c.status}
                        </Pill>
                      </td>
                      <td className="numeric" style={{ textAlign: "right" }}>
                        {c.redemptions}
                      </td>
                      <td className="numeric" style={{ textAlign: "right" }}>
                        {formatCredits(c.redemptions * c.creditAmount)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1rem" }}>
            Recent security events
          </h2>
          {o.recentSecurityEvents.length === 0 ? (
            <p style={{ color: "var(--color-muted)" }}>Nothing recorded.</p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {o.recentSecurityEvents.map((e) => (
                <li
                  key={e.id}
                  style={{
                    padding: "0.625rem 0",
                    borderBottom: "1px solid var(--color-rule-soft)",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "0.75rem",
                  }}
                >
                  <span style={{ fontSize: "var(--text-fine)" }}>
                    <Pill
                      tone={
                        e.severity === "critical"
                          ? "critical"
                          : e.severity === "warning"
                            ? "caution"
                            : "neutral"
                      }
                    >
                      {e.type}
                    </Pill>
                    {e.targetEmail && (
                      <span style={{ color: "var(--color-muted)", marginLeft: "0.5rem" }}>
                        {e.targetEmail}
                      </span>
                    )}
                  </span>
                  <span
                    style={{
                      fontSize: "var(--text-micro)",
                      color: "var(--color-muted)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatRelative(e.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p style={{ marginTop: "1rem", fontSize: "var(--text-fine)" }}>
            <Link to="/admin/security">All security events</Link>
          </p>
        </section>
      </div>

      <section style={{ marginTop: "3rem" }}>
        <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1rem" }}>Recent admin actions</h2>
        {o.recentAdminActions.length === 0 ? (
          <p style={{ color: "var(--color-muted)" }}>No admin actions recorded yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Action</th>
                  <th scope="col">Target</th>
                  <th scope="col">Reason</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {o.recentAdminActions.map((a) => (
                  <tr key={a.id}>
                    <td style={{ fontWeight: 500 }}>{a.action}</td>
                    <td style={{ color: "var(--color-muted)" }}>{a.targetType ?? "—"}</td>
                    <td style={{ color: "var(--color-muted)" }}>{a.reason ?? "—"}</td>
                    <td style={{ whiteSpace: "nowrap", color: "var(--color-muted)" }}>
                      {formatRelative(a.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ marginTop: "1rem", fontSize: "var(--text-fine)" }}>
          <Link to="/admin/audit">Full audit log</Link>
        </p>
      </section>

      <style>{`
        .stat-row { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); }
        .admin-grid { display: grid; gap: 2.5rem; }
        @media (min-width: 1000px) { .admin-grid { grid-template-columns: 1fr 1fr; gap: 3rem; } }
      `}</style>
    </>
  );
}

/** Horizontal funnel with proportional bars and honest drop-off percentages. */
function Funnel({ steps }: { steps: Array<{ label: string; value: number }> }) {
  /**
   * Scale against the LARGEST step, not the first.
   *
   * A funnel's later steps can legitimately exceed its first here: `visitors`
   * counts analytics beacons, while `signup completed` counts rows in `users` —
   * so an account created before analytics existed, or by a seed script, makes
   * step 3 larger than step 1. Normalising against the first step then produced
   * widths like 3000%, which stretched the document to 87,000px and gave the
   * whole admin area a horizontal scrollbar.
   */
  const top = Math.max(...steps.map((s) => s.value), 1);

  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.5rem" }}>
      {steps.map((step, index) => {
        const previous = index > 0 ? steps[index - 1]!.value : null;
        const conversion =
          previous && previous > 0 ? Math.round((step.value / previous) * 100) : null;
        return (
          <li
            key={step.label}
            style={{
              display: "grid",
              // `minmax(0, 1fr)` for the bar column: a plain `1fr` refuses to
              // shrink below its content, which is the other half of how a grid
              // row causes overflow.
              gridTemplateColumns: "minmax(6rem, 12rem) minmax(0, 1fr) 6rem",
              gap: "1rem",
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: "var(--text-fine)", color: "var(--color-muted)" }}>
              {step.label}
            </span>
            <div
              style={{ background: "var(--color-rule-soft)", height: "1.5rem", overflow: "hidden" }}
            >
              <div
                style={{
                  // Clamped, so no data shape can ever overflow the container.
                  width: `${Math.min(Math.max((step.value / top) * 100, step.value > 0 ? 2 : 0), 100)}%`,
                  height: "100%",
                  background: index === steps.length - 1 ? "var(--color-loop)" : "var(--color-ink)",
                }}
              />
            </div>
            <span className="numeric" style={{ fontSize: "var(--text-fine)", textAlign: "right" }}>
              {step.value.toLocaleString("en-GB")}
              {conversion !== null && (
                <span style={{ color: "var(--color-muted)", marginLeft: "0.375rem" }}>
                  {conversion}%
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

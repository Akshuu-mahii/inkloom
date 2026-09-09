import { Form, Link, useActionData, useNavigation, useOutletContext } from "react-router";
import type { Route } from "./+types/user-detail";
import { call } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import {
  Notice,
  PageHeader,
  Pill,
  Stat,
  TextArea,
  formatCredits,
  formatDate,
  formatRelative,
} from "../../components/ui";
import { hasPermission, type Role } from "@inkloom/core/rbac";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "User detail",
    description: "Account detail.",
    path: location.pathname,
    noindex: true,
  });
}

interface Detail {
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    role: string;
    status: string;
    twoFactorEnabled: boolean;
    createdAt: string;
    lastLoginAt: string | null;
    suspendedAt: string | null;
    suspendedReason: string | null;
    earlyAccessJoinedAt: string | null;
    anonymizedAt: string | null;
  };
  credits: {
    balance: number;
    ledger: Array<{
      id: string;
      amount: number;
      type: string;
      balanceAfter: number;
      reason: string;
      actorType: string;
      createdAt: string;
    }>;
  };
  redemptions: Array<{
    id: string;
    campaignName: string;
    creditsGranted: number;
    redeemedAt: string;
  }>;
  sessions: Array<{ id: string; device: string; createdAt: string; lastActiveAt: string }>;
  securityEvents: Array<{ id: string; type: string; severity: string; createdAt: string }>;
  notes: Array<{ id: string; body: string; authorId: string | null; createdAt: string }>;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const result = await call<Detail>(`/admin/users/${params.id}`, { request });
  return { detail: result.data, error: result.error };
}

export async function action({ request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const reason = String(form.get("reason") ?? "");

  const routes: Record<string, { path: string; body?: unknown }> = {
    suspend: { path: `/admin/users/${params.id}/suspend`, body: { reason, revokeSessions: true } },
    unsuspend: { path: `/admin/users/${params.id}/unsuspend`, body: { reason } },
    "revoke-sessions": { path: `/admin/users/${params.id}/revoke-sessions` },
    note: {
      path: `/admin/users/${params.id}/notes`,
      body: { note: String(form.get("note") ?? "") },
    },
  };

  const route = routes[intent];
  if (!route) return { error: "Unknown action.", ok: false };

  const result = await call(route.path, { method: "POST", request, body: route.body ?? {} });
  return result.error ? { error: result.error.message, ok: false } : { error: null, ok: true };
}

export default function UserDetail({ loaderData }: Route.ComponentProps) {
  const { role } = useOutletContext<{ role: Role }>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const d = loaderData.detail;

  if (!d) {
    return (
      <>
        <PageHeader title="User" />
        <Notice tone="critical">{loaderData.error?.message ?? "Not found."}</Notice>
      </>
    );
  }

  const canSuspend = hasPermission(role, "users.suspend");
  const canRevoke = hasPermission(role, "users.revoke_sessions");
  const canNote = hasPermission(role, "users.note");
  const canAdjust = hasPermission(role, "credits.adjust");

  return (
    <>
      <PageHeader
        title={d.user.name}
        description={d.user.email}
        actions={
          <Link to="/admin/users" className="btn btn-quiet">
            Back to users
          </Link>
        }
      />

      {actionData?.error && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="critical">{actionData.error}</Notice>
        </div>
      )}
      {actionData?.ok && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="positive">Done. The action is recorded in the audit log.</Notice>
        </div>
      )}

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "2rem" }}>
        <Pill
          tone={
            d.user.status === "active"
              ? "positive"
              : d.user.status === "suspended"
                ? "critical"
                : "neutral"
          }
        >
          {d.user.status}
        </Pill>
        <Pill tone={d.user.emailVerified ? "positive" : "caution"}>
          {d.user.emailVerified ? "email verified" : "email unverified"}
        </Pill>
        <Pill tone={d.user.twoFactorEnabled ? "positive" : "neutral"}>
          {d.user.twoFactorEnabled ? "2FA on" : "2FA off"}
        </Pill>
        <Pill tone="neutral">{d.user.role.replace("_", " ")}</Pill>
      </div>

      {d.user.suspendedReason && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="critical" title={`Suspended ${formatDate(d.user.suspendedAt, true)}`}>
            {d.user.suspendedReason}
          </Notice>
        </div>
      )}

      <section
        style={{
          display: "grid",
          gap: "1.5rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(8rem, 1fr))",
          paddingBottom: "2rem",
          borderBottom: "1px solid var(--color-rule-soft)",
        }}
      >
        <Stat
          value={d.credits.balance.toLocaleString("en-GB")}
          label="Credit balance"
          tone="loop"
        />
        <Stat value={d.redemptions.length} label="Codes redeemed" />
        <Stat value={d.sessions.length} label="Active sessions" />
        <Stat value={formatDate(d.user.createdAt)} label="Joined" />
      </section>

      {/* --- Actions ---------------------------------------------------- */}
      <section style={{ marginTop: "2.5rem" }}>
        <h2 style={{ fontSize: "var(--text-h4)" }}>Actions</h2>
        <p style={{ marginTop: "0.5rem", color: "var(--color-muted)" }}>
          Every action here is recorded in the audit log with your name and the reason you give.
        </p>

        <div style={{ display: "grid", gap: "1.5rem", marginTop: "1.5rem", maxWidth: "34rem" }}>
          {canSuspend && d.user.status === "active" && (
            <Form method="post" style={{ display: "grid", gap: "0.75rem" }}>
              <input type="hidden" name="intent" value="suspend" />
              <TextArea
                label="Reason for suspending"
                name="reason"
                required
                minLength={4}
                maxLength={500}
                style={{ minHeight: "4.5rem" }}
                hint="Shown to the user in the suspension email."
              />
              <div>
                <button type="submit" className="btn btn-danger" disabled={busy}>
                  Suspend account and end sessions
                </button>
              </div>
            </Form>
          )}

          {canSuspend && d.user.status === "suspended" && (
            <Form method="post" style={{ display: "grid", gap: "0.75rem" }}>
              <input type="hidden" name="intent" value="unsuspend" />
              <TextArea
                label="Reason for restoring"
                name="reason"
                required
                minLength={4}
                maxLength={500}
                style={{ minHeight: "4.5rem" }}
              />
              <div>
                <button type="submit" className="btn btn-ink" disabled={busy}>
                  Restore account
                </button>
              </div>
            </Form>
          )}

          {canRevoke && (
            <Form method="post">
              <input type="hidden" name="intent" value="revoke-sessions" />
              <button type="submit" className="btn btn-quiet" disabled={busy}>
                Sign this user out of all devices
              </button>
            </Form>
          )}

          {canAdjust && (
            <Link to={`/admin/credits?userId=${d.user.id}`} className="btn btn-quiet">
              Adjust credits
            </Link>
          )}
        </div>
      </section>

      {/* --- Credit history ---------------------------------------------- */}
      <section style={{ marginTop: "3rem" }}>
        <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1rem" }}>Credit history</h2>
        {d.credits.ledger.length === 0 ? (
          <p style={{ color: "var(--color-muted)" }}>No credit activity.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Type</th>
                  <th scope="col">Reason</th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Change
                  </th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Balance
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.credits.ledger.map((e) => (
                  <tr key={e.id}>
                    <td style={{ whiteSpace: "nowrap", color: "var(--color-muted)" }}>
                      {formatDate(e.createdAt, true)}
                    </td>
                    <td>{e.type}</td>
                    <td style={{ color: "var(--color-muted)" }}>{e.reason}</td>
                    <td
                      className="numeric"
                      style={{
                        textAlign: "right",
                        fontWeight: 600,
                        color: e.amount > 0 ? "var(--color-positive)" : "var(--color-critical)",
                      }}
                    >
                      {formatCredits(e.amount)}
                    </td>
                    <td
                      className="numeric"
                      style={{ textAlign: "right", color: "var(--color-muted)" }}
                    >
                      {e.balanceAfter}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="detail-grid" style={{ marginTop: "3rem" }}>
        <section>
          <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1rem" }}>Sessions</h2>
          {d.sessions.length === 0 ? (
            <p style={{ color: "var(--color-muted)" }}>No active sessions.</p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {d.sessions.map((s) => (
                <li
                  key={s.id}
                  style={{
                    padding: "0.5rem 0",
                    borderBottom: "1px solid var(--color-rule-soft)",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "1rem",
                    fontSize: "var(--text-fine)",
                  }}
                >
                  <span>{s.device}</span>
                  <span style={{ color: "var(--color-muted)", whiteSpace: "nowrap" }}>
                    {formatRelative(s.lastActiveAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p
            style={{
              marginTop: "0.75rem",
              fontSize: "var(--text-micro)",
              color: "var(--color-muted)",
            }}
          >
            Session tokens are never shown here, or anywhere else.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1rem" }}>Security events</h2>
          {d.securityEvents.length === 0 ? (
            <p style={{ color: "var(--color-muted)" }}>Nothing recorded.</p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {d.securityEvents.slice(0, 12).map((e) => (
                <li
                  key={e.id}
                  style={{
                    padding: "0.5rem 0",
                    borderBottom: "1px solid var(--color-rule-soft)",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "1rem",
                    fontSize: "var(--text-fine)",
                  }}
                >
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
                  <span style={{ color: "var(--color-muted)", whiteSpace: "nowrap" }}>
                    {formatRelative(e.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* --- Internal notes ---------------------------------------------- */}
      {canNote && (
        <section style={{ marginTop: "3rem", maxWidth: "34rem" }}>
          <h2 style={{ fontSize: "var(--text-h4)" }}>Internal notes</h2>
          <p
            style={{
              marginTop: "0.5rem",
              color: "var(--color-muted)",
              fontSize: "var(--text-fine)",
            }}
          >
            Staff only. Never shown to the user, and excluded from their data export.
          </p>

          {d.notes.length > 0 && (
            <ul style={{ listStyle: "none", margin: "1.25rem 0", padding: 0 }}>
              {d.notes.map((n) => (
                <li
                  key={n.id}
                  style={{ padding: "0.75rem 0", borderBottom: "1px solid var(--color-rule-soft)" }}
                >
                  {/* Plain text: a note is never rendered as HTML. */}
                  <p style={{ fontSize: "var(--text-fine)" }}>{n.body}</p>
                  <p
                    style={{
                      fontSize: "var(--text-micro)",
                      color: "var(--color-muted)",
                      marginTop: "0.25rem",
                    }}
                  >
                    {formatRelative(n.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}

          <Form method="post" style={{ display: "grid", gap: "0.75rem", marginTop: "1rem" }}>
            <input type="hidden" name="intent" value="note" />
            <TextArea
              label="Add a note"
              name="note"
              required
              maxLength={2000}
              style={{ minHeight: "5rem" }}
            />
            <div>
              <button type="submit" className="btn btn-quiet" disabled={busy}>
                Save note
              </button>
            </div>
          </Form>
        </section>
      )}

      <style>{`
        .detail-grid { display: grid; gap: 2.5rem; }
        @media (min-width: 900px) { .detail-grid { grid-template-columns: 1fr 1fr; gap: 3rem; } }
      `}</style>
    </>
  );
}

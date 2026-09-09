import { Form, Link, useActionData, useNavigation, useOutletContext } from "react-router";
import type { Route } from "./+types/campaign-detail";
import { call } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import {
  Notice,
  PageHeader,
  Pill,
  Stat,
  TextArea,
  formatDate,
  formatRelative,
} from "../../components/ui";
import { hasPermission, type Role } from "@inkloom/core/rbac";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Campaign",
    description: "Campaign detail.",
    path: location.pathname,
    noindex: true,
  });
}

interface CampaignDetail {
  campaign: {
    id: string;
    name: string;
    description: string | null;
    codeMasked: string;
    codeLast4: string;
    creditAmount: number;
    status: string;
    redemptionCount: number;
    maxTotalRedemptions: number | null;
    maxRedemptionsPerUser: number;
    startsAt: string | null;
    expiresAt: string | null;
    allowedEmailDomains: string[] | null;
    targetCohort: string | null;
    createdAt: string;
    revokedAt: string | null;
    revokedReason: string | null;
  };
  redemptions: Array<{
    id: string;
    userId: string;
    email: string;
    creditsGranted: number;
    redeemedAt: string;
  }>;
  creditsIssued: number;
  suspiciousAttempts: Array<{
    id: string;
    type: string;
    createdAt: string;
    metadata: Record<string, unknown>;
  }>;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const result = await call<CampaignDetail>(`/admin/access-codes/${params.id}`, { request });
  return { detail: result.data, error: result.error };
}

export async function action({ request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const reason = String(form.get("reason") ?? "");

  if (intent !== "pause" && intent !== "revoke") return { error: "Unknown action.", ok: false };

  const result = await call(`/admin/access-codes/${params.id}/${intent}`, {
    method: "POST",
    request,
    body: { reason },
  });
  return result.error ? { error: result.error.message, ok: false } : { error: null, ok: true };
}

export default function CampaignDetailPage({ loaderData }: Route.ComponentProps) {
  const { role } = useOutletContext<{ role: Role }>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const d = loaderData.detail;

  if (!d) {
    return (
      <>
        <PageHeader title="Campaign" />
        <Notice tone="critical">{loaderData.error?.message ?? "Not found."}</Notice>
      </>
    );
  }

  const c = d.campaign;
  const canPause = hasPermission(role, "codes.pause");
  const canRevoke = hasPermission(role, "codes.revoke");
  const isRevoked = c.status === "revoked";

  return (
    <>
      <PageHeader
        title={c.name}
        description={c.description ?? undefined}
        actions={
          <Link to="/admin/access-codes" className="btn btn-quiet">
            All campaigns
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
          <Notice tone="positive">Done, and recorded in the audit log.</Notice>
        </div>
      )}

      {isRevoked && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="critical" title={`Revoked ${formatDate(c.revokedAt, true)}`}>
            {c.revokedReason} — revocation is permanent; this campaign can never be re-enabled.
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
        <div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
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
          </div>
          <p
            style={{
              marginTop: "0.75rem",
              fontSize: "var(--text-fine)",
              color: "var(--color-muted)",
            }}
          >
            Status
          </p>
        </div>
        <Stat value={c.creditAmount} label="Credits each" tone="loop" />
        <Stat
          value={`${c.redemptionCount}${c.maxTotalRedemptions ? ` / ${c.maxTotalRedemptions}` : ""}`}
          label="Redemptions"
        />
        <Stat value={d.creditsIssued.toLocaleString("en-GB")} label="Credits issued" />
        <Stat value={c.maxRedemptionsPerUser} label="Per user" />
      </section>

      <section style={{ marginTop: "2rem" }}>
        <dl
          style={{
            display: "grid",
            gap: "0.625rem",
            fontSize: "var(--text-fine)",
            maxWidth: "34rem",
          }}
        >
          <Row label="Code (masked)">
            <span className="identifier">{c.codeMasked}</span>
          </Row>
          <Row label="Created">{formatDate(c.createdAt, true)}</Row>
          <Row label="Expires">{c.expiresAt ? formatDate(c.expiresAt) : "Never"}</Row>
          <Row label="Cohort">{c.targetCohort ?? "—"}</Row>
          <Row label="Restricted to">
            {c.allowedEmailDomains?.join(", ") ?? "Any verified email"}
          </Row>
        </dl>
        <p
          style={{ marginTop: "1rem", fontSize: "var(--text-micro)", color: "var(--color-muted)" }}
        >
          The full code is not stored and cannot be displayed again.
        </p>
      </section>

      {!isRevoked && (canPause || canRevoke) && (
        <section style={{ marginTop: "3rem", maxWidth: "34rem" }}>
          <h2 style={{ fontSize: "var(--text-h4)" }}>Campaign controls</h2>

          <div style={{ display: "grid", gap: "1.75rem", marginTop: "1.25rem" }}>
            {canPause && (
              <Form method="post" style={{ display: "grid", gap: "0.75rem" }}>
                <input type="hidden" name="intent" value="pause" />
                <TextArea
                  label={c.status === "paused" ? "Reason for resuming" : "Reason for pausing"}
                  name="reason"
                  required
                  minLength={4}
                  maxLength={500}
                  style={{ minHeight: "4rem" }}
                  hint={
                    c.status === "paused"
                      ? "Redemptions will start working again."
                      : "Redemptions are refused while paused. Reversible."
                  }
                />
                <div>
                  <button type="submit" className="btn btn-quiet" disabled={busy}>
                    {c.status === "paused" ? "Resume campaign" : "Pause campaign"}
                  </button>
                </div>
              </Form>
            )}

            {canRevoke && (
              <Form
                method="post"
                style={{
                  display: "grid",
                  gap: "0.75rem",
                  paddingTop: "1.5rem",
                  borderTop: "1px solid var(--color-critical)",
                }}
              >
                <input type="hidden" name="intent" value="revoke" />
                <TextArea
                  label="Reason for revoking"
                  name="reason"
                  required
                  minLength={4}
                  maxLength={500}
                  style={{ minHeight: "4rem" }}
                  hint="Permanent. Use this when a code has leaked — it can never be re-enabled."
                />
                <div>
                  <button type="submit" className="btn btn-danger" disabled={busy}>
                    Revoke permanently
                  </button>
                </div>
              </Form>
            )}
          </div>
        </section>
      )}

      <section style={{ marginTop: "3rem" }}>
        <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1rem" }}>Redemptions</h2>
        {d.redemptions.length === 0 ? (
          <p style={{ color: "var(--color-muted)" }}>Nobody has redeemed this code yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="sr-only">Who redeemed this campaign</caption>
              <thead>
                <tr>
                  <th scope="col">User</th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Credits
                  </th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {d.redemptions.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/admin/users/${r.userId}`}>{r.email}</Link>
                    </td>
                    <td className="numeric" style={{ textAlign: "right" }}>
                      {r.creditsGranted}
                    </td>
                    <td style={{ whiteSpace: "nowrap", color: "var(--color-muted)" }}>
                      {formatDate(r.redeemedAt, true)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {d.suspiciousAttempts.length > 0 && (
        <section style={{ marginTop: "3rem" }}>
          <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1rem" }}>Refused attempts</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {d.suspiciousAttempts.map((a) => (
              <li
                key={a.id}
                style={{
                  padding: "0.5rem 0",
                  borderBottom: "1px solid var(--color-rule-soft)",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "1rem",
                  fontSize: "var(--text-fine)",
                }}
              >
                <span>{String((a.metadata as { reason?: string }).reason ?? a.type)}</span>
                <span style={{ color: "var(--color-muted)" }}>{formatRelative(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
      <dt style={{ color: "var(--color-muted)" }}>{label}</dt>
      <dd style={{ margin: 0, textAlign: "right" }}>{children}</dd>
    </div>
  );
}

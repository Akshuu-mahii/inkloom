import {
  Form,
  Link,
  useActionData,
  useNavigation,
  useOutletContext,
  useSearchParams,
} from "react-router";
import type { Route } from "./+types/credits";
import { call, fieldErrors, type Paged } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import {
  Field,
  Notice,
  PageHeader,
  TextArea,
  formatCredits,
  formatCreditDelta,
  formatDate,
} from "../../components/ui";
import { hasPermission, type Role } from "@inkloom/core/rbac";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Credits",
    description: "Credit ledger.",
    path: location.pathname,
    noindex: true,
  });
}

interface LedgerRow {
  id: string;
  userId: string;
  email: string;
  amount: number;
  type: string;
  balanceAfter: number;
  reason: string;
  actorType: string;
  actorId: string | null;
  createdAt: string;
}

export async function loader({ request }: Route.LoaderArgs) {
  const incoming = new URL(request.url).searchParams;
  const query = new URLSearchParams({ limit: "50" });
  for (const key of ["userId", "type", "cursor"]) {
    const value = incoming.get(key);
    if (value) query.set(key, value);
  }

  const result = await call<Paged<LedgerRow>>(`/admin/credits/ledger?${query}`, { request });
  return { entries: result.data?.items ?? [], nextCursor: result.data?.page.nextCursor ?? null };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "adjust") {
    const result = await call<{ balanceBefore: number; balanceAfter: number }>(
      "/admin/credits/adjust",
      {
        method: "POST",
        request,
        body: {
          userId: String(form.get("userId") ?? ""),
          amount: Number(form.get("amount") ?? 0),
          reason: String(form.get("reason") ?? ""),
        },
      },
    );
    return result.error
      ? {
          intent: "adjust" as const,
          error: result.error.message,
          fields: fieldErrors(result.error),
          result: null,
        }
      : {
          intent: "adjust" as const,
          error: null,
          fields: {} as Record<string, string>,
          result: result.data,
        };
  }

  if (intent === "reconcile") {
    const result = await call<{ checked: number; drifted: unknown[]; repaired: number }>(
      "/admin/credits/reconcile",
      { method: "POST", request },
    );
    return result.error
      ? {
          intent: "reconcile" as const,
          error: result.error.message,
          fields: {} as Record<string, string>,
          result: null,
        }
      : {
          intent: "reconcile" as const,
          error: null,
          fields: {} as Record<string, string>,
          result: result.data,
        };
  }

  return {
    intent: "unknown" as const,
    error: "Unknown action.",
    fields: {} as Record<string, string>,
    result: null,
  };
}

export default function AdminCredits({ loaderData }: Route.ComponentProps) {
  const { role } = useOutletContext<{ role: Role }>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [params] = useSearchParams();
  const busy = navigation.state === "submitting";

  const canAdjust = hasPermission(role, "credits.adjust");
  const canReconcile = hasPermission(role, "credits.reconcile");

  return (
    <>
      <PageHeader
        title="Credits"
        description="The ledger is the source of truth. Nothing here edits history."
      />

      <div style={{ marginBottom: "2rem" }}>
        <Notice tone="info" title="Corrections are appended, never edited">
          A ledger entry cannot be changed or deleted — the database forbids it. To correct a
          mistake, reverse it: that appends a compensating entry and leaves both visible.
        </Notice>
      </div>

      {actionData?.intent === "adjust" && actionData.result && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="positive" title="Adjustment applied">
            Balance moved from {formatCredits(actionData.result.balanceBefore)} to{" "}
            {formatCredits(actionData.result.balanceAfter)}.
          </Notice>
        </div>
      )}
      {actionData?.intent === "reconcile" && actionData.result && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice
            tone={actionData.result.drifted.length === 0 ? "positive" : "critical"}
            title="Reconciliation complete"
          >
            Checked {actionData.result.checked} wallets.{" "}
            {actionData.result.drifted.length === 0
              ? "Every balance matches its ledger."
              : `${actionData.result.drifted.length} wallet(s) disagree with the ledger — investigate before repairing.`}
          </Notice>
        </div>
      )}
      {actionData?.error && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="critical">{actionData.error}</Notice>
        </div>
      )}

      <div className="credits-grid">
        <section>
          <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1rem" }}>Ledger</h2>
          <div className="table-scroll">
            <table className="data-table">
              <caption className="sr-only">Credit ledger, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">User</th>
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
                {loaderData.entries.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ color: "var(--color-muted)" }}>
                      No entries.
                    </td>
                  </tr>
                ) : (
                  loaderData.entries.map((e) => (
                    <tr key={e.id}>
                      <td style={{ whiteSpace: "nowrap", color: "var(--color-muted)" }}>
                        {formatDate(e.createdAt, true)}
                      </td>
                      <td>
                        <Link to={`/admin/users/${e.userId}`}>{e.email}</Link>
                      </td>
                      <td style={{ fontSize: "var(--text-micro)" }}>{e.type}</td>
                      <td style={{ color: "var(--color-muted)" }}>{e.reason}</td>
                      <td
                        className="numeric"
                        style={{
                          textAlign: "right",
                          fontWeight: 600,
                          color: e.amount > 0 ? "var(--color-positive)" : "var(--color-critical)",
                        }}
                      >
                        {formatCreditDelta(e.amount)}
                      </td>
                      <td
                        className="numeric"
                        style={{ textAlign: "right", color: "var(--color-muted)" }}
                      >
                        {e.balanceAfter}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {loaderData.nextCursor && (
            <p style={{ marginTop: "1.25rem" }}>
              <Link
                to={`/admin/credits?cursor=${encodeURIComponent(loaderData.nextCursor)}`}
                className="btn btn-quiet"
              >
                Older entries
              </Link>
            </p>
          )}
        </section>

        <aside style={{ display: "grid", gap: "2rem", alignContent: "start" }}>
          {canAdjust ? (
            <section className="panel" style={{ padding: "1.25rem" }}>
              <h2
                style={{
                  fontSize: "var(--text-lead)",
                  fontFamily: "var(--font-sans)",
                  letterSpacing: 0,
                }}
              >
                Adjust a balance
              </h2>
              <Form method="post" style={{ display: "grid", gap: "1rem", marginTop: "1rem" }}>
                <input type="hidden" name="intent" value="adjust" />
                <Field
                  label="User id"
                  name="userId"
                  required
                  defaultValue={params.get("userId") ?? ""}
                  placeholder="usr_…"
                  style={{ fontFamily: "var(--font-mono)" }}
                  error={actionData?.fields?.userId}
                />
                <Field
                  label="Amount"
                  name="amount"
                  type="number"
                  required
                  hint="Positive adds credits, negative removes them."
                  error={actionData?.fields?.amount}
                />
                <TextArea
                  label="Reason"
                  name="reason"
                  required
                  minLength={4}
                  maxLength={500}
                  style={{ minHeight: "4rem" }}
                  hint="Mandatory, and stored on the ledger entry itself."
                  error={actionData?.fields?.reason}
                />
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  Apply adjustment
                </button>
              </Form>
            </section>
          ) : (
            <Notice tone="info">Adjusting credits is reserved to a super admin.</Notice>
          )}

          {canReconcile && (
            <section style={{ border: "1px solid var(--color-rule-soft)", padding: "1.25rem" }}>
              <h2
                style={{
                  fontSize: "var(--text-lead)",
                  fontFamily: "var(--font-sans)",
                  letterSpacing: 0,
                }}
              >
                Reconciliation
              </h2>
              <p
                style={{
                  marginTop: "0.5rem",
                  fontSize: "var(--text-fine)",
                  color: "var(--color-muted)",
                }}
              >
                Re-sums every ledger and compares it with the cached wallet balance. A difference
                is, by definition, a bug.
              </p>
              <Form method="post" style={{ marginTop: "1rem" }}>
                <input type="hidden" name="intent" value="reconcile" />
                <button
                  type="submit"
                  className="btn btn-quiet"
                  disabled={busy}
                  style={{ width: "100%" }}
                >
                  Run reconciliation
                </button>
              </Form>
            </section>
          )}
        </aside>
      </div>

      <style>{`
        .credits-grid { display: grid; gap: 2.5rem; }
        @media (min-width: 1050px) { .credits-grid { grid-template-columns: 1fr 20rem; gap: 3rem; } }
      `}</style>
    </>
  );
}

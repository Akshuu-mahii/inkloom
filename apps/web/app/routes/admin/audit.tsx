import { Form, Link, useSearchParams } from "react-router";
import { adminUrl, useAdminPath } from "./admin-path";
import type { Route } from "./+types/audit";
import { call, type Paged } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Empty, Notice, PageHeader, formatDate } from "../../components/ui";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Audit log",
    description: "Audit trail.",
    path: location.pathname,
    noindex: true,
  });
}

interface AuditRow {
  id: string;
  action: string;
  actorType: string;
  actorId: string | null;
  actorRole: string | null;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  createdAt: string;
}

export async function loader({ request }: Route.LoaderArgs) {
  const incoming = new URL(request.url).searchParams;
  const query = new URLSearchParams({ limit: "50" });
  for (const key of ["action", "actorId", "targetId", "cursor"]) {
    const value = incoming.get(key);
    if (value) query.set(key, value);
  }
  const result = await call<Paged<AuditRow>>(`/admin/audit?${query}`, { request });
  return { entries: result.data?.items ?? [], nextCursor: result.data?.page.nextCursor ?? null };
}

export default function AuditLog({ loaderData }: Route.ComponentProps) {
  const adminPath = useAdminPath();
  const [params] = useSearchParams();

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every consequential action, who took it, and why."
      />

      <div style={{ marginBottom: "1.5rem" }}>
        <Notice tone="info">
          Append-only, enforced by a database trigger rather than by convention — the application
          cannot edit or delete a row here even if it tried.
        </Notice>
      </div>

      <Form
        method="get"
        style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1.5rem" }}
      >
        <input
          className="input"
          name="action"
          placeholder="Action, e.g. admin.credits.adjust"
          defaultValue={params.get("action") ?? ""}
          aria-label="Filter by action"
          style={{ maxWidth: "20rem" }}
        />
        <input
          className="input"
          name="targetId"
          placeholder="Target id"
          defaultValue={params.get("targetId") ?? ""}
          aria-label="Filter by target"
          style={{ maxWidth: "16rem" }}
        />
        <button type="submit" className="btn btn-ink">
          Filter
        </button>
      </Form>

      {loaderData.entries.length === 0 ? (
        <Empty title="Nothing recorded yet">Admin actions will appear here as they happen.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="sr-only">Audit events, newest first</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Action</th>
                <th scope="col">Actor</th>
                <th scope="col">Target</th>
                <th scope="col">Reason</th>
                <th scope="col">Request</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.entries.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: "nowrap", color: "var(--color-muted)" }}>
                    {formatDate(e.createdAt, true)}
                  </td>
                  <td style={{ fontWeight: 500 }}>{e.action}</td>
                  <td>
                    {e.actorId ? (
                      <Link to={adminUrl(adminPath, `users/${e.actorId}`)}>
                        {e.actorRole ?? e.actorType}
                      </Link>
                    ) : (
                      <span style={{ color: "var(--color-muted)" }}>{e.actorType}</span>
                    )}
                  </td>
                  <td style={{ color: "var(--color-muted)" }}>
                    {e.targetType && e.targetId ? (
                      e.targetType === "user" ? (
                        <Link to={adminUrl(adminPath, `users/${e.targetId}`)}>{e.targetType}</Link>
                      ) : e.targetType === "campaign" ? (
                        <Link to={adminUrl(adminPath, `access-codes/${e.targetId}`)}>
                          {e.targetType}
                        </Link>
                      ) : (
                        e.targetType
                      )
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={{ color: "var(--color-muted)", maxWidth: "18rem" }}>
                    {e.reason ?? "—"}
                  </td>
                  <td className="identifier">{e.requestId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loaderData.nextCursor && (
        <p style={{ marginTop: "1.5rem" }}>
          <Link
            to={adminUrl(adminPath, `audit?cursor=${encodeURIComponent(loaderData.nextCursor)}`)}
            className="btn btn-quiet"
          >
            Older entries
          </Link>
        </p>
      )}
    </>
  );
}

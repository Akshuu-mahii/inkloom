import { Form, Link, useActionData, useNavigation, useSearchParams } from "react-router";
import { adminUrl, useAdminPath } from "./admin-path";
import type { Route } from "./+types/support";
import { call, type Paged } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Empty, Notice, PageHeader, Pill, formatRelative } from "../../components/ui";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Support queue",
    description: "Support requests.",
    path: location.pathname,
    noindex: true,
  });
}

interface SupportRow {
  id: string;
  reference: string;
  userId: string | null;
  email: string;
  name: string | null;
  category: string;
  priority: string;
  status: string;
  subject: string;
  message: string;
  resolutionNote: string | null;
  createdAt: string;
}

export async function loader({ request }: Route.LoaderArgs) {
  const incoming = new URL(request.url).searchParams;
  const query = new URLSearchParams({ limit: "50" });
  for (const key of ["status", "priority", "cursor"]) {
    const value = incoming.get(key);
    if (value) query.set(key, value);
  }
  const result = await call<Paged<SupportRow>>(`/admin/support?${query}`, { request });
  return { requests: result.data?.items ?? [], nextCursor: result.data?.page.nextCursor ?? null };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const id = String(form.get("id") ?? "");
  const result = await call(`/admin/support/${id}`, {
    method: "PATCH",
    request,
    body: {
      status: String(form.get("status") ?? ""),
      resolutionNote: String(form.get("resolutionNote") ?? ""),
    },
  });
  return result.error ? { error: result.error.message, ok: false } : { error: null, ok: true };
}

export default function AdminSupport({ loaderData }: Route.ComponentProps) {
  const adminPath = useAdminPath();
  const [params] = useSearchParams();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();

  return (
    <>
      <PageHeader
        title="Support queue"
        description="Requests from the contact form and the dashboard."
      />

      {actionData?.ok && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="positive">Updated.</Notice>
        </div>
      )}
      {actionData?.error && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="critical">{actionData.error}</Notice>
        </div>
      )}

      <Form
        method="get"
        style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1.5rem" }}
      >
        <select
          className="input"
          name="status"
          defaultValue={params.get("status") ?? ""}
          aria-label="Filter by status"
          style={{ maxWidth: "13rem" }}
        >
          <option value="">Any status</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="waiting_on_user">Waiting on user</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>
        <button type="submit" className="btn btn-ink">
          Filter
        </button>
      </Form>

      {loaderData.requests.length === 0 ? (
        <Empty title="Nothing in the queue">Support requests will appear here.</Empty>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "1rem" }}>
          {loaderData.requests.map((r) => (
            <li key={r.id} className="panel" style={{ padding: "1.25rem" }}>
              <div
                style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}
              >
                <span className="identifier" style={{ fontWeight: 600, color: "var(--color-ink)" }}>
                  {r.reference}
                </span>
                <Pill
                  tone={
                    r.status === "open"
                      ? "caution"
                      : r.status === "resolved"
                        ? "positive"
                        : "neutral"
                  }
                >
                  {r.status.replace("_", " ")}
                </Pill>
                <Pill
                  tone={r.priority === "high" || r.priority === "urgent" ? "critical" : "neutral"}
                >
                  {r.priority}
                </Pill>
                <Pill tone="neutral">{r.category.replace("_", " ")}</Pill>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: "var(--text-micro)",
                    color: "var(--color-muted)",
                  }}
                >
                  {formatRelative(r.createdAt)}
                </span>
              </div>

              <h2
                style={{
                  fontSize: "var(--text-lead)",
                  fontFamily: "var(--font-sans)",
                  letterSpacing: 0,
                  marginTop: "0.75rem",
                }}
              >
                {r.subject}
              </h2>
              <p
                style={{
                  marginTop: "0.25rem",
                  fontSize: "var(--text-fine)",
                  color: "var(--color-muted)",
                }}
              >
                {r.userId ? (
                  <Link to={adminUrl(adminPath, `users/${r.userId}`)}>{r.email}</Link>
                ) : (
                  r.email
                )}
                {r.name ? ` · ${r.name}` : ""}
              </p>

              {/* User-supplied text, rendered as TEXT. Markup in a message is inert. */}
              <p style={{ marginTop: "0.875rem", whiteSpace: "pre-wrap", maxWidth: "none" }}>
                {r.message}
              </p>

              <Form
                method="post"
                style={{
                  display: "flex",
                  gap: "0.625rem",
                  flexWrap: "wrap",
                  marginTop: "1.25rem",
                  alignItems: "flex-end",
                }}
              >
                <input type="hidden" name="id" value={r.id} />
                <div style={{ minWidth: "11rem" }}>
                  <label className="field-label" htmlFor={`status-${r.id}`}>
                    Status
                  </label>
                  <select
                    id={`status-${r.id}`}
                    className="input"
                    name="status"
                    defaultValue={r.status}
                  >
                    <option value="open">Open</option>
                    <option value="in_progress">In progress</option>
                    <option value="waiting_on_user">Waiting on user</option>
                    <option value="resolved">Resolved</option>
                    <option value="closed">Closed</option>
                  </select>
                </div>
                <div style={{ flex: 1, minWidth: "14rem" }}>
                  <label className="field-label" htmlFor={`note-${r.id}`}>
                    Note to the user
                  </label>
                  <input
                    id={`note-${r.id}`}
                    className="input"
                    name="resolutionNote"
                    defaultValue={r.resolutionNote ?? ""}
                    maxLength={2000}
                  />
                </div>
                <button
                  type="submit"
                  className="btn btn-quiet"
                  disabled={navigation.state === "submitting"}
                >
                  Update
                </button>
              </Form>
            </li>
          ))}
        </ul>
      )}

      {loaderData.nextCursor && (
        <p style={{ marginTop: "1.5rem" }}>
          <Link
            to={adminUrl(adminPath, `support?cursor=${encodeURIComponent(loaderData.nextCursor)}`)}
            className="btn btn-quiet"
          >
            Older requests
          </Link>
        </p>
      )}
    </>
  );
}

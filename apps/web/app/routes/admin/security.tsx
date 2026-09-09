import { Link, useSearchParams, Form } from "react-router";
import type { Route } from "./+types/security";
import { call } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Empty, Notice, PageHeader, Pill, formatDate } from "../../components/ui";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Security",
    description: "Security events.",
    path: location.pathname,
    noindex: true,
  });
}

interface SecurityRow {
  id: string;
  type: string;
  severity: string;
  userId: string | null;
  targetEmail: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

interface SecurityResponse {
  items: SecurityRow[];
  page: { nextCursor: string | null; hasMore: boolean };
  abuseFlags: Array<{
    id: string;
    subjectType: string;
    subjectKey: string;
    kind: string;
    severity: string;
    hitCount: number;
    createdAt: string;
  }>;
  rateLimitBlocks: Array<{ bucket: string; blocked: string }>;
}

export async function loader({ request }: Route.LoaderArgs) {
  const incoming = new URL(request.url).searchParams;
  const query = new URLSearchParams({ limit: "50" });
  for (const key of ["type", "severity", "cursor"]) {
    const value = incoming.get(key);
    if (value) query.set(key, value);
  }
  const result = await call<SecurityResponse>(`/admin/security?${query}`, { request });
  return { data: result.data };
}

export default function AdminSecurity({ loaderData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  const d = loaderData.data;

  return (
    <>
      <PageHeader
        title="Security"
        description="Failed logins, rate limits, refused redemptions and admin activity."
      />

      <div style={{ marginBottom: "1.5rem" }}>
        <Notice tone="info">
          IP addresses are never stored. Abuse subjects are rotating keyed hashes, which allow
          correlation within a day but cannot be reversed to an address.
        </Notice>
      </div>

      {d && d.rateLimitBlocks.length > 0 && (
        <section style={{ marginBottom: "2.5rem" }}>
          <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1rem" }}>
            Rate limits tripped (24h)
          </h2>
          <ul
            style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.375rem" }}
          >
            {d.rateLimitBlocks.map((b) => (
              <li
                key={b.bucket}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "1rem",
                  padding: "0.5rem 0",
                  borderBottom: "1px solid var(--color-rule-soft)",
                  fontSize: "var(--text-fine)",
                }}
              >
                <span className="identifier">{b.bucket}</span>
                <span className="numeric">{b.blocked}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Form
        method="get"
        style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1.5rem" }}
      >
        <input
          className="input"
          name="type"
          placeholder="Event type, e.g. login_failed"
          defaultValue={params.get("type") ?? ""}
          aria-label="Filter by type"
          style={{ maxWidth: "20rem" }}
        />
        <select
          className="input"
          name="severity"
          defaultValue={params.get("severity") ?? ""}
          aria-label="Filter by severity"
          style={{ maxWidth: "11rem" }}
        >
          <option value="">Any severity</option>
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="critical">Critical</option>
        </select>
        <button type="submit" className="btn btn-ink">
          Filter
        </button>
      </Form>

      {!d || d.items.length === 0 ? (
        <Empty title="No security events">Nothing has been recorded for these filters.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="sr-only">Security events, newest first</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Event</th>
                <th scope="col">Severity</th>
                <th scope="col">Account</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: "nowrap", color: "var(--color-muted)" }}>
                    {formatDate(e.createdAt, true)}
                  </td>
                  <td style={{ fontWeight: 500 }}>{e.type}</td>
                  <td>
                    <Pill
                      tone={
                        e.severity === "critical"
                          ? "critical"
                          : e.severity === "warning"
                            ? "caution"
                            : "neutral"
                      }
                    >
                      {e.severity}
                    </Pill>
                  </td>
                  <td>
                    {e.userId ? (
                      <Link to={`/admin/users/${e.userId}`}>{e.targetEmail ?? "account"}</Link>
                    ) : (
                      <span style={{ color: "var(--color-muted)" }}>{e.targetEmail ?? "—"}</span>
                    )}
                  </td>
                  <td
                    style={{
                      color: "var(--color-muted)",
                      fontSize: "var(--text-micro)",
                      maxWidth: "20rem",
                      wordBreak: "break-word",
                    }}
                  >
                    {summarise(e.metadata)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {d && d.abuseFlags.length > 0 && (
        <section style={{ marginTop: "3rem" }}>
          <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1rem" }}>Abuse flags</h2>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Subject</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Severity</th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Hits
                  </th>
                  <th scope="col">Since</th>
                </tr>
              </thead>
              <tbody>
                {d.abuseFlags.map((f) => (
                  <tr key={f.id}>
                    <td className="identifier">
                      {f.subjectType}:{f.subjectKey.slice(0, 12)}…
                    </td>
                    <td>{f.kind}</td>
                    <td>
                      <Pill tone={f.severity === "critical" ? "critical" : "caution"}>
                        {f.severity}
                      </Pill>
                    </td>
                    <td className="numeric" style={{ textAlign: "right" }}>
                      {f.hitCount}
                    </td>
                    <td style={{ color: "var(--color-muted)" }}>{formatDate(f.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {d?.page.nextCursor && (
        <p style={{ marginTop: "1.5rem" }}>
          <Link
            to={`/admin/security?cursor=${encodeURIComponent(d.page.nextCursor)}`}
            className="btn btn-quiet"
          >
            Older events
          </Link>
        </p>
      )}
    </>
  );
}

/** Render metadata as a short key=value line. Never dangerouslySetInnerHTML. */
function summarise(metadata: Record<string, unknown>): string {
  const parts = Object.entries(metadata ?? {})
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .slice(0, 4)
    .map(
      ([key, value]) =>
        `${key}=${typeof value === "object" ? JSON.stringify(value).slice(0, 30) : String(value)}`,
    );
  return parts.length ? parts.join(" · ") : "—";
}

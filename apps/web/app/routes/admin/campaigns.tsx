import { Link, useOutletContext } from "react-router";
import { adminUrl, useAdminPath } from "./admin-path";
import type { Route } from "./+types/campaigns";
import { call } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Empty, Notice, PageHeader, Pill, formatDate } from "../../components/ui";
import { hasPermission, type Role } from "@inkloom/core/rbac";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Access codes",
    description: "Code campaigns.",
    path: location.pathname,
    noindex: true,
  });
}

interface Campaign {
  id: string;
  name: string;
  description: string | null;
  codeMasked: string;
  creditAmount: number;
  status: string;
  redemptionCount: number;
  maxTotalRedemptions: number | null;
  maxRedemptionsPerUser: number;
  startsAt: string | null;
  expiresAt: string | null;
  lastRedeemedAt: string | null;
  targetCohort: string | null;
  createdAt: string;
}

export async function loader({ request }: Route.LoaderArgs) {
  const result = await call<{ campaigns: Campaign[] }>("/admin/access-codes", { request });
  return { campaigns: result.data?.campaigns ?? [], error: result.error };
}

export default function Campaigns({ loaderData }: Route.ComponentProps) {
  const adminPath = useAdminPath();
  const { role } = useOutletContext<{ role: Role }>();

  return (
    <>
      <PageHeader
        title="Access codes"
        description="Campaigns that grant promotional credits."
        actions={
          hasPermission(role, "codes.create") ? (
            <Link to={adminUrl(adminPath, "access-codes/new")} className="btn btn-primary">
              Create a campaign
            </Link>
          ) : undefined
        }
      />

      <div style={{ marginBottom: "1.5rem" }}>
        <Notice tone="info">
          Codes are stored only as a keyed HMAC. The full code is shown once, when it is created,
          and cannot be recovered afterwards — not from this screen, not from the database.
        </Notice>
      </div>

      {loaderData.campaigns.length === 0 ? (
        <Empty
          title="No campaigns yet"
          action={
            hasPermission(role, "codes.create")
              ? { label: "Create a campaign", to: adminUrl(adminPath, "access-codes/new") }
              : undefined
          }
        >
          A campaign turns a code into credits.
        </Empty>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="sr-only">Access-code campaigns</caption>
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                <th scope="col">Code</th>
                <th scope="col">Status</th>
                <th scope="col" style={{ textAlign: "right" }}>
                  Credits
                </th>
                <th scope="col" style={{ textAlign: "right" }}>
                  Redeemed
                </th>
                <th scope="col">Expires</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.campaigns.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link
                      to={adminUrl(adminPath, `access-codes/${c.id}`)}
                      style={{ fontWeight: 500 }}
                    >
                      {c.name}
                    </Link>
                    {c.targetCohort && (
                      <>
                        <br />
                        <span
                          style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}
                        >
                          {c.targetCohort}
                        </span>
                      </>
                    )}
                  </td>
                  {/* The masked value only — never the fingerprint. */}
                  <td className="identifier">{c.codeMasked}</td>
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
                    {c.creditAmount}
                  </td>
                  <td className="numeric" style={{ textAlign: "right" }}>
                    {c.redemptionCount}
                    {c.maxTotalRedemptions ? ` / ${c.maxTotalRedemptions}` : ""}
                  </td>
                  <td style={{ whiteSpace: "nowrap", color: "var(--color-muted)" }}>
                    {c.expiresAt ? formatDate(c.expiresAt) : "never"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

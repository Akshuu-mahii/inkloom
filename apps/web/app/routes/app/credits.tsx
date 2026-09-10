import { Link, useOutletContext } from "react-router";
import type { Route } from "./+types/credits";
import { call, type LedgerEntry, type Me, type Paged } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import {
  Empty,
  Notice,
  PageHeader,
  Stat,
  formatCreditDelta,
  formatCredits,
  formatDate,
} from "../../components/ui";
import { TrackView } from "../../components/track";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Your credits",
    description: "Your Inkloom credit balance and history.",
    path: location.pathname,
    noindex: true,
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");

  const history = await call<Paged<LedgerEntry>>(
    `/credits/history?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    { request },
  );

  return {
    entries: history.data?.items ?? [],
    nextCursor: history.data?.page.nextCursor ?? null,
  };
}

const TYPE_LABELS: Record<string, string> = {
  EARLY_ACCESS_GRANT: "Access code",
  PROMOTIONAL_GRANT: "Promotional grant",
  ADMIN_GRANT: "Added by Inkloom",
  ADMIN_DEDUCTION: "Removed by Inkloom",
  EXPIRY: "Expired",
  REVERSAL: "Correction",
};

export default function Credits({ loaderData }: Route.ComponentProps) {
  const { me } = useOutletContext<{ me: Me }>();

  return (
    <>
      <TrackView event="credits_viewed" />
      <PageHeader
        title="Credits"
        description="Every change to your balance, newest first."
        actions={
          <Link to="/app/redeem" className="btn btn-primary">
            Redeem a code
          </Link>
        }
      />

      <section
        style={{
          display: "grid",
          gap: "2rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
          paddingBottom: "2rem",
          borderBottom: "1px solid var(--color-rule-soft)",
          marginBottom: "2rem",
        }}
      >
        <Stat value={formatCredits(me.credits.balance)} label="Current balance" tone="loop" />
        <Stat value={loaderData.entries.length} label="Entries shown" />
        <Stat value={me.redemptions} label="Codes redeemed" />
      </section>

      <div style={{ marginBottom: "2rem" }}>
        <Notice tone="info" title="What credits are for">
          Credits are the unit Inkloom will charge for generation. Generation is not live yet, so
          nothing is spending them — your balance only goes up for now.
        </Notice>
      </div>

      {loaderData.entries.length === 0 ? (
        <Empty
          title="No credits yet"
          action={{ label: "Redeem an access code", to: "/app/redeem" }}
        >
          Redeem an early-access code to add promotional credits.
        </Empty>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="sr-only">Your credit history, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">What happened</th>
                <th scope="col" style={{ textAlign: "right" }}>
                  Change
                </th>
                <th scope="col" style={{ textAlign: "right" }}>
                  Balance
                </th>
              </tr>
            </thead>
            <tbody>
              {loaderData.entries.map((entry) => (
                <tr key={entry.id}>
                  <td style={{ whiteSpace: "nowrap", color: "var(--color-muted)" }}>
                    {formatDate(entry.createdAt, true)}
                  </td>
                  <td>
                    <span style={{ fontWeight: 500 }}>{TYPE_LABELS[entry.type] ?? entry.type}</span>
                    <br />
                    <span style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
                      {entry.campaignName ?? entry.reason}
                    </span>
                  </td>
                  <td
                    className="numeric"
                    style={{
                      textAlign: "right",
                      fontWeight: 600,
                      color: entry.amount > 0 ? "var(--color-positive)" : "var(--color-critical)",
                    }}
                  >
                    {formatCreditDelta(entry.amount)}
                  </td>
                  <td
                    className="numeric"
                    style={{ textAlign: "right", color: "var(--color-muted)" }}
                  >
                    {formatCredits(entry.balanceAfter)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loaderData.nextCursor && (
        <p style={{ marginTop: "1.5rem" }}>
          <Link
            to={`/app/credits?cursor=${encodeURIComponent(loaderData.nextCursor)}`}
            className="btn btn-quiet"
          >
            Load older entries
          </Link>
        </p>
      )}
    </>
  );
}

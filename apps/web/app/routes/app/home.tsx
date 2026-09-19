import { Link, useOutletContext, useSearchParams } from "react-router";
import type { Route } from "./+types/home";
import { call, type LedgerEntry, type Me, type Paged } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import {
  Empty,
  Notice,
  PageHeader,
  Pill,
  Stat,
  formatCredits,
  formatCreditDelta,
  formatRelative,
} from "../../components/ui";
import { servicesContext } from "../../lib/context";
import { TrackView } from "../../components/track";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Your dashboard",
    description: "Your Inkloom account.",
    path: location.pathname,
    noindex: true,
  });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { settings } = context.get(servicesContext);

  const [history, announcement] = await Promise.all([
    call<Paged<LedgerEntry>>("/credits/history?limit=5", { request }),
    settings.get("announcement"),
  ]);

  return {
    recent: history.data?.items ?? [],
    announcement: announcement.visible ? announcement : null,
  };
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { me } = useOutletContext<{ me: Me }>();
  const [params] = useSearchParams();
  const justVerified = params.get("welcome") === "1";

  const firstName = me.name.split(" ")[0] || "there";

  /*
   * How this account signs in, said in the words people use.
   *
   * "Which email did I use, and did I sign up with Google?" is the question
   * behind most password-reset attempts, and the answer was only on /app/profile
   * — a page you go looking for, after you already suspect something is wrong.
   * It belongs where you land.
   */
  const signIn = me.providers.includes("google")
    ? me.providers.includes("credential")
      ? "Google or password"
      : "Google"
    : "Password";

  return (
    <>
      <TrackView event="dashboard_viewed" />
      <PageHeader
        title={`Welcome back, ${firstName}`}
        description="Your early-access account. Generation opens later — your credits are waiting."
      />

      <p
        style={{
          marginTop: "-1.25rem",
          marginBottom: "1.75rem",
          fontSize: "var(--text-fine)",
          color: "var(--color-muted)",
        }}
      >
        Signed in as <strong style={{ color: "var(--color-ink)" }}>{me.email}</strong>
        {" \u00b7 "}
        {signIn}
        {" \u00b7 "}
        <Link to="/app/profile">Manage account</Link>
      </p>

      {justVerified && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="positive" title="Email confirmed">
            You are all set. Redeem an access code to add credits to your account.
          </Notice>
        </div>
      )}

      {loaderData.announcement && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="info" title={loaderData.announcement.title}>
            {loaderData.announcement.body}
          </Notice>
        </div>
      )}

      <section
        style={{
          display: "grid",
          gap: "2rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
          paddingBottom: "2rem",
          borderBottom: "1px solid var(--color-rule-soft)",
        }}
      >
        <Stat
          value={formatCredits(me.credits.balance)}
          label="Credits reserved"
          tone="loop"
          hint="Usable when generation opens"
        />
        <Stat value={me.redemptions} label="Codes redeemed" />
        <div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <Pill tone={me.emailVerified ? "positive" : "caution"}>
              {me.emailVerified ? "Email verified" : "Email unverified"}
            </Pill>
          </div>
          <p
            style={{
              marginTop: "0.75rem",
              fontSize: "var(--text-fine)",
              color: "var(--color-muted)",
            }}
          >
            Account status
          </p>
        </div>
        <div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <Pill tone={me.earlyAccess.joined ? "positive" : "neutral"}>
              {me.earlyAccess.joined ? "Early access member" : "Not yet joined"}
            </Pill>
          </div>
          <p
            style={{
              marginTop: "0.75rem",
              fontSize: "var(--text-fine)",
              color: "var(--color-muted)",
            }}
          >
            Membership
          </p>
        </div>
      </section>

      <div className="dash-grid">
        <section>
          <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1rem" }}>
            Recent credit activity
          </h2>
          {loaderData.recent.length === 0 ? (
            <Empty
              title="No credit activity yet"
              action={{ label: "Redeem an access code", to: "/app/redeem" }}
            >
              Redeem an early-access code and your credits appear here.
            </Empty>
          ) : (
            <>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {loaderData.recent.map((entry) => (
                  <li
                    key={entry.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "1rem",
                      padding: "0.875rem 0",
                      borderBottom: "1px solid var(--color-rule-soft)",
                    }}
                  >
                    <div>
                      <p style={{ fontWeight: 500 }}>{entry.campaignName ?? entry.reason}</p>
                      <p style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
                        {formatRelative(entry.createdAt)}
                      </p>
                    </div>
                    <span
                      className="numeric"
                      style={{
                        fontWeight: 600,
                        color: entry.amount > 0 ? "var(--color-positive)" : "var(--color-ink)",
                      }}
                    >
                      {formatCreditDelta(entry.amount)}
                    </span>
                  </li>
                ))}
              </ul>
              <p style={{ marginTop: "1rem", fontSize: "var(--text-fine)" }}>
                <Link to="/app/credits">See full credit history</Link>
              </p>
            </>
          )}
        </section>

        <aside style={{ display: "grid", gap: "1.5rem", alignContent: "start" }}>
          <div className="panel" style={{ padding: "1.25rem" }}>
            <h2
              style={{
                fontSize: "var(--text-lead)",
                fontFamily: "var(--font-sans)",
                letterSpacing: 0,
              }}
            >
              Have an access code?
            </h2>
            <p
              style={{
                marginTop: "0.5rem",
                fontSize: "var(--text-fine)",
                color: "var(--color-muted)",
              }}
            >
              Redeem it to add promotional credits to your account.
            </p>
            <Link
              to="/app/redeem"
              className="btn btn-primary"
              style={{ marginTop: "1rem", width: "100%" }}
            >
              Redeem a code
            </Link>
          </div>

          <div style={{ border: "1px solid var(--color-rule-soft)", padding: "1.25rem" }}>
            <h2
              style={{
                fontSize: "var(--text-lead)",
                fontFamily: "var(--font-sans)",
                letterSpacing: 0,
              }}
            >
              Where the product is
            </h2>
            <ul
              style={{
                listStyle: "none",
                margin: "0.875rem 0 0",
                padding: 0,
                display: "grid",
                gap: "0.625rem",
                fontSize: "var(--text-fine)",
              }}
            >
              <li style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
                <span style={{ color: "var(--color-muted)" }}>Accounts and credits</span>
                <Pill tone="positive">Live</Pill>
              </li>
              <li style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
                <span style={{ color: "var(--color-muted)" }}>Logo generation</span>
                <Pill tone="neutral">In development</Pill>
              </li>
              <li style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
                <span style={{ color: "var(--color-muted)" }}>Paid plans</span>
                <Pill tone="neutral">Not yet</Pill>
              </li>
            </ul>
          </div>

          <p style={{ fontSize: "var(--text-fine)", color: "var(--color-muted)" }}>
            Something wrong? <Link to="/app/support">Contact support</Link>
          </p>
        </aside>
      </div>

      <style>{`
        .dash-grid { display: grid; gap: 2.5rem; padding-top: 2rem; }
        @media (min-width: 940px) { .dash-grid { grid-template-columns: 1fr 20rem; gap: 3rem; } }
      `}</style>
    </>
  );
}

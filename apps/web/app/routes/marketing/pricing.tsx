import { Link } from "react-router";
import type { Route } from "./+types/pricing";
import { buildMeta } from "../../lib/seo";
import { Notice } from "../../components/ui";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Pricing",
    description:
      "Planned Inkloom pricing. Nothing is for sale yet — early access reserves free promotional credits.",
    path: location.pathname,
  });
}

/**
 * The pricing page.
 *
 * There is deliberately NO checkout, no "Buy" button, and no `Offer` structured
 * data: Inkloom is not selling anything, and a page that implies otherwise
 * would be a lie a search engine would happily amplify. Every number below is
 * labelled as planned, and the page says outright that it may change.
 */
export default function Pricing() {
  return (
    <>
      <section className="measure" style={{ paddingBlock: "clamp(3rem, 7vw, 5rem) 2.5rem" }}>
        <h1 style={{ fontSize: "clamp(2.25rem, 5.5vw, var(--text-h1))", maxWidth: "16ch" }}>
          Pricing, planned
        </h1>
        <p
          style={{
            marginTop: "1.5rem",
            fontSize: "var(--text-lead)",
            color: "var(--color-ink-soft)",
          }}
        >
          Inkloom is not selling anything yet. This is where pricing is heading, published early so
          nobody is surprised later.
        </p>

        <div style={{ marginTop: "2rem", maxWidth: "44rem" }}>
          <Notice tone="caution" title="Nothing on this page can be bought today">
            There is no checkout, and no card is ever requested. Early-access credits are free and
            promotional. Plans and generation costs may change before paid launch — if they do, we
            will tell early-access members before it applies to them.
          </Notice>
        </div>
      </section>

      <section className="measure" style={{ paddingBottom: "clamp(2.5rem, 5vw, 4rem)" }}>
        <div className="plans">
          {[
            {
              name: "Early access",
              price: "Free",
              note: "Available now",
              current: true,
              points: [
                "Promotional credits, granted by code",
                "Credits do not expire",
                "First access when generation opens",
                "Launch pricing locked in",
              ],
            },
            {
              name: "Starter",
              price: "Planned",
              note: "At paid launch",
              current: false,
              points: [
                "A monthly credit allowance",
                "Full commercial rights",
                "Vector output",
                "Standard support",
              ],
            },
            {
              name: "Studio",
              price: "Planned",
              note: "At paid launch",
              current: false,
              points: [
                "A larger allowance and top-ups",
                "Brand-kit generation (V2)",
                "Priority generation",
                "Priority support",
              ],
            },
          ].map((plan) => (
            <div
              key={plan.name}
              style={{
                border: `1px solid ${plan.current ? "var(--color-ink)" : "var(--color-rule)"}`,
                padding: "1.75rem",
                background: plan.current ? "var(--color-panel)" : "transparent",
              }}
            >
              <h2 style={{ fontSize: "var(--text-h4)" }}>{plan.name}</h2>
              <p
                style={{
                  marginTop: "0.75rem",
                  fontFamily: "var(--font-display)",
                  fontSize: "var(--text-h2)",
                  lineHeight: 1,
                  // `--color-rule` is a border tone (1.4:1) and unreadable as text.
                  color: plan.current ? "var(--color-loop-deep)" : "var(--color-muted)",
                }}
              >
                {plan.price}
              </p>
              <p
                style={{
                  marginTop: "0.5rem",
                  fontSize: "var(--text-fine)",
                  color: "var(--color-muted)",
                }}
              >
                {plan.note}
              </p>

              <ul
                style={{
                  listStyle: "none",
                  margin: "1.5rem 0 0",
                  padding: 0,
                  display: "grid",
                  gap: "0.625rem",
                }}
              >
                {plan.points.map((point) => (
                  <li
                    key={point}
                    style={{ display: "flex", gap: "0.625rem", fontSize: "var(--text-fine)" }}
                  >
                    <span aria-hidden="true" style={{ color: "var(--color-loop)" }}>
                      —
                    </span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>

              {plan.current ? (
                <Link
                  to="/auth/signup"
                  className="btn btn-primary"
                  style={{ marginTop: "1.75rem", width: "100%" }}
                >
                  Join early access
                </Link>
              ) : (
                <p
                  style={{
                    marginTop: "1.75rem",
                    fontSize: "var(--text-fine)",
                    color: "var(--color-muted)",
                    padding: "0.75rem 0",
                    borderTop: "1px solid var(--color-rule-soft)",
                  }}
                >
                  Not available yet
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="measure" style={{ paddingBottom: "clamp(3rem, 6vw, 4.5rem)" }}>
        <h2 style={{ fontSize: "var(--text-h3)", maxWidth: "20ch" }}>How credits work</h2>
        <dl className="credit-facts">
          <div>
            <dt>What a credit is</dt>
            <dd>
              The unit Inkloom will charge for generation work. One generation will cost a set
              number of credits; the exact number is not fixed yet, because the models are not
              finished.
            </dd>
          </div>
          <div>
            <dt>What early-access credits are</dt>
            <dd>
              Promotional. They cost nothing, they are granted by redeeming a code, and they are
              yours.
            </dd>
          </div>
          <div>
            <dt>Whether they expire</dt>
            <dd>
              They do not. If that ever changes we will tell you first, and it will not apply
              retroactively to credits already granted.
            </dd>
          </div>
          <div>
            <dt>What can spend them today</dt>
            <dd>Nothing. Generation is not enabled, so your balance only goes up for now.</dd>
          </div>
          <div>
            <dt>What might change</dt>
            <dd>
              Plan names, prices, and how many credits a generation costs. Credits already in your
              account will not be taken away.
            </dd>
          </div>
        </dl>
      </section>

      <style>{`
        .plans { display: grid; gap: 1.5rem; }
        @media (min-width: 800px) { .plans { grid-template-columns: repeat(3, 1fr); } }
        .credit-facts { margin: 2rem 0 0; padding: 0; border-top: 1px solid var(--color-rule); }
        .credit-facts > div { padding: 1.25rem 0; border-bottom: 1px solid var(--color-rule-soft); }
        .credit-facts dt { font-weight: 600; }
        .credit-facts dd { margin: 0.375rem 0 0; color: var(--color-muted); max-width: 60ch; }
        @media (min-width: 800px) {
          .credit-facts > div { display: grid; grid-template-columns: 24ch 1fr; gap: 2rem; align-items: baseline; }
          .credit-facts dd { margin-top: 0; }
        }
      `}</style>
    </>
  );
}

import { Link } from "react-router";
import type { Route } from "./+types/early-access";
import { buildMeta } from "../../lib/seo";
import { servicesContext } from "../../lib/context";
import { TrackView } from "../../components/track";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Join Inkloom early access",
    description:
      "Reserve free promotional credits and be among the first to use Inkloom's logo models when they open.",
    path: location.pathname,
  });
}

export async function loader({ context }: Route.LoaderArgs) {
  const { settings } = context.get(servicesContext);
  return {
    open: await settings.isEnabled("early_access_open"),
    signupEnabled: await settings.isEnabled("signup_enabled"),
  };
}

export default function EarlyAccess({ loaderData }: Route.ComponentProps) {
  const open = loaderData.open && loaderData.signupEnabled;

  return (
    <>
      <TrackView event="early_access_viewed" />
      <section className="measure" style={{ paddingBlock: "clamp(3rem, 7vw, 5rem) 2.5rem" }}>
        <h1 style={{ fontSize: "clamp(2.25rem, 5.5vw, var(--text-h1))", maxWidth: "15ch" }}>
          Join early access
        </h1>
        <p
          style={{
            marginTop: "1.5rem",
            fontSize: "var(--text-lead)",
            color: "var(--color-ink-soft)",
            maxWidth: "42ch",
          }}
        >
          Create an account, redeem a code, and your free credits wait on your account until the
          logo models open.
        </p>

        {open ? (
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "2.5rem", flexWrap: "wrap" }}>
            <Link to="/auth/signup" className="btn btn-primary">
              Create your account
            </Link>
            <Link to="/how-it-works" className="btn btn-outline">
              How it will work
            </Link>
          </div>
        ) : (
          <div
            style={{
              marginTop: "2.5rem",
              borderLeft: "3px solid var(--color-caution)",
              paddingLeft: "1rem",
              maxWidth: "40rem",
            }}
          >
            <p style={{ fontWeight: 600 }}>Early access is closed for now.</p>
            <p style={{ marginTop: "0.375rem", color: "var(--color-muted)" }}>
              We have paused new registrations while we work through the current cohort.{" "}
              <Link to="/contact">Get in touch</Link> and we will let you know when it reopens.
            </p>
          </div>
        )}
      </section>

      <section className="measure" style={{ paddingBottom: "clamp(3rem, 6vw, 4.5rem)" }}>
        <ol className="ea-steps">
          {[
            ["Create an account", "Email and a password. No card, no trial, nothing to cancel."],
            [
              "Confirm your email",
              "One click from your inbox. Verification is required before any credits are granted.",
            ],
            [
              "Redeem your code",
              "Enter the code you were given. Credits appear on your account immediately.",
            ],
            [
              "Wait for the models",
              "We will email you the moment generation opens. Your credits will be there.",
            ],
          ].map(([title, body], index) => (
            <li key={title}>
              <span className="ea-index numeric" aria-hidden="true">
                {index + 1}
              </span>
              <div>
                <h2 style={{ fontSize: "var(--text-h4)" }}>{title}</h2>
                <p style={{ marginTop: "0.375rem", color: "var(--color-muted)" }}>{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="measure" style={{ paddingBottom: "clamp(3rem, 6vw, 4.5rem)" }}>
        <h2 style={{ fontSize: "var(--text-h3)", maxWidth: "20ch" }}>
          What you are actually joining
        </h2>
        <p style={{ marginTop: "1rem", color: "var(--color-muted)", fontSize: "var(--text-lead)" }}>
          Inkloom cannot generate a logo today. Early access is a place in the queue and a balance
          of free credits — not a product you can use this afternoon. We would rather say that
          plainly than have you find out after signing up.
        </p>
      </section>

      <style>{`
        .ea-steps { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--color-rule); }
        .ea-steps > li { display: grid; grid-template-columns: 2.5rem 1fr; gap: 1.25rem; padding: 1.5rem 0; border-bottom: 1px solid var(--color-rule-soft); }
        .ea-index { font-family: var(--font-display); font-size: var(--text-h4); color: var(--color-faint); line-height: 1.1; }
      `}</style>
    </>
  );
}

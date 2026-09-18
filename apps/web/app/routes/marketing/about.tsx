import { Link } from "react-router";
import type { Route } from "./+types/about";
import { buildMeta } from "../../lib/seo";
import { InfinitySpecimen } from "../../components/infinity-mark";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "About Inkloom",
    description:
      "Why Inkloom is building specialised models for logo design rather than using a general image model.",
    path: location.pathname,
  });
}

export default function About() {
  return (
    <>
      <section className="measure" style={{ paddingBlock: "clamp(3rem, 7vw, 5rem) 2.5rem" }}>
        <h1 style={{ fontSize: "clamp(2.25rem, 5.5vw, var(--text-h1))", maxWidth: "17ch" }}>
          A logo is a system, not a picture
        </h1>
        <div style={{ marginTop: "2rem", display: "grid", gap: "1.25rem", maxWidth: "60ch" }}>
          <p style={{ fontSize: "var(--text-lead)", color: "var(--color-ink-soft)" }}>
            Ask a general image model for a logo and you get something that looks like one. Then you
            try to use it: the edges are soft, the text is nearly right, there is no vector behind
            it, and the second version shares nothing with the first.
          </p>
          <p style={{ color: "var(--color-muted)" }}>
            That is not a prompt problem. A logo has to survive one colour, one inch and a hundred
            applications, and the rules that make that possible are typographic and geometric —
            weight, width, tangency, optical correction, clear space. They are learnable. They are
            just not what a general image model was built to learn.
          </p>
          <p style={{ color: "var(--color-muted)" }}>
            So Inkloom is building four specialised models instead: one that turns a description of
            a business into design constraints, one that sets type, one that constructs symbols, and
            one that composes them into a lockup. Slower to build. Considerably more useful at the
            end.
          </p>
        </div>
      </section>

      <section className="measure" style={{ paddingBottom: "clamp(3rem, 6vw, 4.5rem)" }}>
        <div className="about-grid">
          <div>
            <h2 style={{ fontSize: "var(--text-h3)", maxWidth: "18ch" }}>Where we actually are</h2>
            <dl className="status">
              <div>
                <dt>Accounts, credits, early access</dt>
                <dd>Live</dd>
              </div>
              <div>
                <dt>Reference systems and training data</dt>
                <dd>In progress</dd>
              </div>
              <div>
                <dt>Typography and symbol models</dt>
                <dd>In development</dd>
              </div>
              <div>
                <dt>Composition engine</dt>
                <dd>In development</dd>
              </div>
              <div>
                <dt>Generation for users</dt>
                <dd>Not yet</dd>
              </div>
              <div>
                <dt>Paid plans</dt>
                <dd>Not yet</dd>
              </div>
            </dl>
            <p style={{ marginTop: "1.5rem", color: "var(--color-muted)" }}>
              We publish this because a waiting list that pretends to be a product wastes everyone's
              time.
            </p>
          </div>
          <div style={{ display: "grid", placeItems: "center" }}>
            <InfinitySpecimen size={300} />
          </div>
        </div>
      </section>

      <section className="measure" style={{ paddingBottom: "clamp(3rem, 6vw, 4.5rem)" }}>
        <div style={{ border: "1px solid var(--color-ink)", padding: "clamp(1.75rem, 4vw, 3rem)" }}>
          <h2 style={{ fontSize: "var(--text-h3)", maxWidth: "22ch" }}>
            Early access is open while we build.
          </h2>
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1.75rem", flexWrap: "wrap" }}>
            <Link to="/auth/signup" className="btn btn-primary">
              Join early access
            </Link>
            <Link to="/contact" className="btn btn-outline">
              Talk to us
            </Link>
          </div>
        </div>
      </section>

      <style>{`
        .about-grid { display: grid; gap: 2.5rem; }
        .status { margin: 1.5rem 0 0; padding: 0; border-top: 1px solid var(--color-rule); }
        .status > div { display: flex; justify-content: space-between; gap: 1.5rem; padding: 0.75rem 0; border-bottom: 1px solid var(--color-rule-soft); font-size: var(--text-fine); }
        .status dt { color: var(--color-muted); }
        .status dd { margin: 0; font-weight: 600; white-space: nowrap; }
        @media (min-width: 900px) { .about-grid { grid-template-columns: 1.2fr 0.8fr; gap: 4rem; align-items: center; } }
      `}</style>
    </>
  );
}

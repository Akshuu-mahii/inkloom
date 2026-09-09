import { Link } from "react-router";
import type { Route } from "./+types/examples";
import { buildMeta } from "../../lib/seo";
import { MarkGallery, MARK_COUNT } from "../../components/mark-gallery";
import { SectionHead } from "./home";
import { TrackView } from "../../components/track";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Logo examples and reference marks",
    description:
      "The geometric systems Inkloom's models are being built around: construction, tangency, monoline terminals and counter rhythm.",
    path: location.pathname,
  });
}

export default function Examples() {
  return (
    <>
      <TrackView event="examples_viewed" />
      <section className="measure" style={{ paddingBlock: "clamp(3rem, 7vw, 5rem) 2.5rem" }}>
        <h1 style={{ fontSize: "clamp(2.25rem, 5.5vw, var(--text-h1))", maxWidth: "16ch" }}>
          Reference marks
        </h1>
        <p
          style={{
            marginTop: "1.5rem",
            fontSize: "var(--text-lead)",
            color: "var(--color-ink-soft)",
          }}
        >
          {MARK_COUNT} constructions showing the systems Inkloom is being taught: how a mark is
          built from primitives, where strokes meet, and what stays legible at one inch.
        </p>

        {/* The honest framing, stated where nobody can miss it. */}
        <div
          style={{
            marginTop: "2rem",
            borderLeft: "3px solid var(--color-loop)",
            paddingLeft: "1rem",
            maxWidth: "44rem",
          }}
        >
          <p style={{ fontWeight: 600 }}>These are not generated output.</p>
          <p style={{ marginTop: "0.375rem", color: "var(--color-muted)" }}>
            Inkloom's models are in development and are not generating logos yet. Every mark below
            was constructed by hand to illustrate a specific rule. When generation opens, this page
            becomes a gallery of real output — and we will say so plainly.
          </p>
        </div>
      </section>

      <section className="measure" style={{ paddingBottom: "clamp(3rem, 6vw, 4.5rem)" }}>
        <MarkGallery />
      </section>

      <section className="measure" style={{ paddingBottom: "clamp(3rem, 6vw, 4.5rem)" }}>
        <SectionHead
          heading="What makes a mark work"
          support="The rules the models are learning, in the order they matter."
        />
        <dl className="rules">
          {[
            [
              "Reduces to one colour",
              "If it needs a gradient to read, it fails on a stamp, an invoice and an embroidered shirt.",
            ],
            [
              "Survives one inch",
              "Detail that disappears at favicon size was decoration, not structure.",
            ],
            [
              "Consistent stroke logic",
              "Monoline or modulated — but the same rule everywhere, or the mark looks assembled rather than drawn.",
            ],
            [
              "Optical, not mathematical",
              "A circle next to a square needs to be bigger to look the same size. Centring by numbers looks wrong.",
            ],
            [
              "Clear space that is part of the mark",
              "A logo with nothing around it is a logo nobody can place on a page.",
            ],
          ].map(([term, detail]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{detail}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="measure" style={{ paddingBottom: "clamp(3rem, 6vw, 4.5rem)" }}>
        <div style={{ border: "1px solid var(--color-ink)", padding: "clamp(1.75rem, 4vw, 3rem)" }}>
          <h2 style={{ fontSize: "var(--text-h3)", maxWidth: "20ch" }}>
            Be there when these become generated.
          </h2>
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1.75rem", flexWrap: "wrap" }}>
            <Link to="/auth/signup" className="btn btn-primary">
              Join early access
            </Link>
            <Link to="/how-it-works" className="btn btn-outline">
              How it will work
            </Link>
          </div>
        </div>
      </section>

      <style>{`
        .rules { margin: 0; padding: 0; border-top: 1px solid var(--color-rule); }
        .rules > div { padding: 1.25rem 0; border-bottom: 1px solid var(--color-rule-soft); }
        .rules dt { font-family: var(--font-display); font-weight: 600; font-size: var(--text-h4); letter-spacing: -0.02em; }
        .rules dd { margin: 0.375rem 0 0; color: var(--color-muted); max-width: 60ch; }
        @media (min-width: 800px) {
          .rules > div { display: grid; grid-template-columns: 22ch 1fr; gap: 2rem; align-items: baseline; }
          .rules dd { margin-top: 0; }
        }
      `}</style>
    </>
  );
}

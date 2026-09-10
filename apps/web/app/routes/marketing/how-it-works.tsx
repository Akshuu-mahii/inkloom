import { Link } from "react-router";
import type { Route } from "./+types/how-it-works";
import { buildMeta } from "../../lib/seo";
import { SectionHead } from "./home";
import { ConstructionMark, ConstructionScroll } from "../../components/construction-scroll";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "How Inkloom will work",
    description:
      "Four specialised models — brand analysis, typography, symbol construction and composition — instead of one general image model.",
    path: location.pathname,
  });
}

export default function HowItWorks() {
  return (
    <>
      <section className="measure" style={{ paddingBlock: "clamp(3rem, 7vw, 5rem) 3rem" }}>
        <h1 style={{ fontSize: "clamp(2.25rem, 5.5vw, var(--text-h1))", maxWidth: "18ch" }}>
          Four models, each doing one job well
        </h1>
        <p
          style={{
            marginTop: "1.5rem",
            fontSize: "var(--text-lead)",
            color: "var(--color-ink-soft)",
          }}
        >
          A general image model draws a picture of a logo. Inkloom builds one — from typographic and
          geometric systems, so the result has structure you can actually use.
        </p>
        <p style={{ marginTop: "1rem", color: "var(--color-muted)" }}>
          This describes the pipeline in development. None of it is running for users yet.
        </p>
      </section>

      <section
        style={{
          background: "var(--color-panel)",
          borderBlock: "1px solid var(--color-rule)",
          paddingBlock: "clamp(3rem, 6vw, 4.5rem)",
        }}
      >
        <div className="measure">
          <ol className="stages">
            {[
              {
                title: "Brand analysis",
                lede: "Turns a description of a business into constraints.",
                body: "Sector, audience, tone and competitors become concrete parameters: stroke weight, width, geometry, counter shape, and which symbol families are appropriate. This is the step that stops the output being a generic aesthetic — it is reasoned about before anything is drawn.",
              },
              {
                title: "Typography",
                lede: "Sets the wordmark.",
                body: "Selects and fits letterforms against those constraints, then handles what actually makes a wordmark: optical spacing, kerning at display size, and whether the name needs a custom ligature the way inkloom's own 'oo' does.",
              },
              {
                title: "Symbol construction",
                lede: "Builds the mark.",
                body: "Composes geometric primitives under construction rules — shared radii, tangent junctions, consistent terminals — so what comes out is built rather than sampled, and can be described as a spec sheet rather than a bitmap.",
              },
              {
                title: "Composition",
                lede: "Locks it up.",
                body: "Optical alignment rather than mathematical centring, clear-space ratios derived from the mark itself, and the lockup variants a brand actually needs: horizontal, stacked, and the symbol standing alone.",
              },
            ].map((stage, index) => (
              <li key={stage.title}>
                <span className="stage-index numeric" aria-hidden="true">
                  {index + 1}
                </span>
                <div>
                  <h2 style={{ fontSize: "var(--text-h3)" }}>{stage.title}</h2>
                  <p style={{ marginTop: "0.5rem", fontSize: "var(--text-lead)" }}>{stage.lede}</p>
                  <p style={{ marginTop: "0.75rem", color: "var(--color-muted)" }}>{stage.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="measure" style={{ paddingBlock: "clamp(3rem, 6vw, 4.5rem)" }}>
        <div className="worked">
          <div>
            <SectionHead
              heading="A worked example"
              support="Inkloom's own mark, built by the rules the models are learning."
            />
            <dl className="spec">
              <div>
                <dt>Constraint</dt>
                <dd>Two counters, equal weight, continuous stroke</dd>
              </div>
              <div>
                <dt>Primitive</dt>
                <dd>Two circles, radius 158</dd>
              </div>
              <div>
                <dt>Junction</dt>
                <dd>Tangent at the midpoint, no visible seam</dd>
              </div>
              <div>
                <dt>Stroke</dt>
                <dd>Monoline, 13 units, round terminals</dd>
              </div>
              <div>
                <dt>Result</dt>
                <dd>Reads as "oo" in the wordmark, as a loop alone</dd>
              </div>
            </dl>
          </div>
          <div style={{ display: "grid", placeItems: "center" }}>
            {/* The mark builds itself as the section scrolls past. */}
            <ConstructionScroll>
              <ConstructionMark size={340} />
            </ConstructionScroll>
          </div>
        </div>
      </section>

      <section className="measure" style={{ paddingBottom: "clamp(3rem, 6vw, 4.5rem)" }}>
        <div style={{ border: "1px solid var(--color-ink)", padding: "clamp(1.75rem, 4vw, 3rem)" }}>
          <h2 style={{ fontSize: "var(--text-h3)", maxWidth: "22ch" }}>
            Reserve your credits before the models open.
          </h2>
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1.75rem", flexWrap: "wrap" }}>
            <Link to="/auth/signup" className="btn btn-primary">
              Join early access
            </Link>
            <Link to="/examples" className="btn btn-outline">
              See reference marks
            </Link>
          </div>
        </div>
      </section>

      <style>{`
        .stages { list-style: none; margin: 0; padding: 0; display: grid; }
        .stages > li { display: grid; grid-template-columns: 2.5rem 1fr; gap: 1.25rem; padding: 2rem 0; border-top: 1px solid var(--color-rule-soft); }
        .stages > li:first-child { border-top: none; padding-top: 0; }
        .stage-index { font-family: var(--font-display); font-size: var(--text-h3); color: var(--color-faint); line-height: 1; }
        .worked { display: grid; gap: 2.5rem; }
        .spec { margin: 0; padding: 0; border-top: 1px solid var(--color-rule); }
        .spec > div { display: flex; justify-content: space-between; gap: 1.5rem; padding: 0.75rem 0; border-bottom: 1px solid var(--color-rule-soft); font-size: var(--text-fine); }
        .spec dt { color: var(--color-muted); }
        .spec dd { margin: 0; text-align: right; }
        @media (min-width: 900px) {
          .stages > li { grid-template-columns: 3.5rem 1fr; }
          .worked { grid-template-columns: 1fr 1fr; gap: 4rem; align-items: center; }
        }
      `}</style>
    </>
  );
}

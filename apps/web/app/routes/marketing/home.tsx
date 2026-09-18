import { useRef } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/home";
import { InfinitySpecimen } from "../../components/infinity-mark";
import { buildMeta, faqJsonLd, organizationJsonLd, websiteJsonLd } from "../../lib/seo";
import { TrackView } from "../../components/track";
import { track } from "../../lib/analytics";
import { useDrawnRules } from "../../components/editorial-motion";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Inkloom — logo models, in construction",
    description:
      "Inkloom is building specialised AI models for logo design: typography systems, symbol libraries and a composition engine. Join early access and reserve your free credits.",
    path: location.pathname,
  });
}

/**
 * The homepage.
 *
 * The honest framing matters here: generation is NOT live. Every claim on this
 * page is either present-tense true ("we are building"), or explicitly framed
 * as future ("when generation opens"). No CTA promises a logo today.
 */
export default function Home() {
  const page = useRef<HTMLDivElement>(null);
  useDrawnRules(page);

  return (
    <div ref={page}>
      <TrackView event="landing_viewed" />
      <script
        type="application/ld+json"
        // Structured data is generated from constants, never from user input.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([organizationJsonLd(), websiteJsonLd(), faqJsonLd(FAQS)]),
        }}
      />
      <Hero />
      <Approach />
      <Systems />
      <Benefits />
      <Faq />
      <FinalCta />
    </div>
  );
}

/**
 * Hero.
 *
 * The most characteristic thing in Inkloom's world is a mark being
 * constructed, so that is what opens the page: the loop draws itself once, over
 * the construction circles a real logo specification sheet would show. It is a
 * single orchestrated moment — nothing else on the page animates on load.
 */
function Hero() {
  return (
    <section
      className="measure"
      style={{ paddingBlock: "clamp(3rem, 9vw, 7rem) clamp(3rem, 7vw, 5.5rem)" }}
    >
      <div className="hero-grid">
        <div>
          <p
            style={{
              fontSize: "var(--text-fine)",
              color: "var(--color-muted)",
              marginBottom: "1.5rem",
            }}
          >
            In development. Not generating yet.
          </p>

          <h1 style={{ fontSize: "clamp(2.75rem, 7vw, var(--text-hero))", maxWidth: "13ch" }}>
            Logos, built the way designers build them.
          </h1>

          <p
            style={{
              marginTop: "1.75rem",
              fontSize: "var(--text-lead)",
              color: "var(--color-ink-soft)",
              maxWidth: "38ch",
            }}
          >
            Inkloom is training specialised models on typography systems, symbol construction and
            composition — not one general image model asked nicely for a logo.
          </p>

          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              marginTop: "2.5rem",
              flexWrap: "wrap",
            }}
          >
            <Link
              to="/auth/signup"
              className="btn btn-primary"
              onClick={() => track("primary_cta_clicked", { location: "hero" })}
            >
              Join early access
            </Link>
            <Link to="/how-it-works" className="btn btn-outline">
              How it works
            </Link>
          </div>

          <p
            style={{
              marginTop: "1.25rem",
              fontSize: "var(--text-fine)",
              color: "var(--color-muted)",
            }}
          >
            Reserve your free credits now. They wait on your account until the models open.
          </p>
        </div>

        <div className="hero-mark">
          <InfinitySpecimen size={420} />
          {/* The spec describes the mark that is actually on the page. It used
              to read "two circles, r = 158", which was the wordmark's "oo" —
              a different construction from this one, and wrong beside it. */}
          <dl className="spec-list">
            <div>
              <dt>Construction</dt>
              <dd>One continuous path</dd>
            </div>
            <div>
              <dt>Crossing</dt>
              <dd>Single, at the midpoint</dd>
            </div>
            <div>
              <dt>Terminals</dt>
              <dd>None — the path never ends</dd>
            </div>
          </dl>
        </div>
      </div>

      <style>{`
        .hero-grid { display: grid; gap: 3.5rem; }
        .hero-mark { display: none; }
        .spec-list {
          margin: 2rem 0 0; padding: 1rem 0 0;
          border-top: 1px solid var(--color-rule);
          display: grid; gap: 0.625rem;
          font-size: var(--text-fine);
        }
        .spec-list > div { display: flex; justify-content: space-between; gap: 1rem; }
        .spec-list dt { color: var(--color-muted); }
        .spec-list dd { margin: 0; color: var(--color-ink); }
        @media (min-width: 900px) {
          .hero-grid { grid-template-columns: 1.05fr 0.95fr; align-items: center; gap: 4rem; }
          .hero-mark { display: block; }
        }
      `}</style>
    </section>
  );
}

/** How Inkloom will work. Genuinely a sequence, so it is numbered. */
function Approach() {
  const steps = [
    {
      title: "Describe the business",
      body: "Name, sector, what it does, who it serves, and the character you want. Plain language, no prompt engineering.",
    },
    {
      title: "The brand model reads it",
      body: "A brand-analysis model turns that into concrete constraints: weight, width, geometry, counter shapes, and the symbol families that fit.",
    },
    {
      title: "Type and symbol models run",
      body: "A typography model sets the wordmark; a symbol model constructs the mark. They run against those constraints, not against a general aesthetic.",
    },
    {
      title: "The composition engine locks it up",
      body: "Optical alignment, clear space, and the lockup variants a real brand needs — horizontal, stacked, and the mark on its own.",
    },
  ];

  return (
    <section
      style={{
        background: "var(--color-panel)",
        borderBlock: "1px solid var(--color-rule)",
        paddingBlock: "clamp(3.5rem, 7vw, 5.5rem)",
      }}
    >
      <div className="measure">
        <SectionHead
          heading="How Inkloom will work"
          support="Four stages, each handled by a model built for that job. This is the pipeline in development — nothing here is running for users yet."
        />

        <ol className="steps">
          {steps.map((step, index) => (
            <li key={step.title}>
              <span className="rule-draw" data-rule aria-hidden="true" />
              <span className="step-index numeric" aria-hidden="true">
                {index + 1}
              </span>
              {/* h3 and p are DIRECT grid children, not wrapped in a div. The
                  wrapper was the bug: it filled column two by itself, so the
                  third column stayed empty and every step's text ran down a
                  narrow gutter with two thirds of the page beside it. */}
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </div>

      <style>{`
        .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; }
        .steps > li {
          position: relative; display: grid; grid-template-columns: 3rem 1fr;
          gap: 0.5rem 1.25rem; padding: 1.75rem 0;
        }
        .steps .rule-draw { position: absolute; inset-inline: 0; top: 0; height: 1px; background: var(--color-rule-soft); }
        .steps > li:last-child { border-bottom: 1px solid var(--color-rule-soft); }
        .steps h3 { font-size: var(--text-h4); }
        .steps p { color: var(--color-muted); }
        .step-index {
          font-family: var(--font-display); font-size: var(--text-h4);
          color: var(--color-faint); line-height: 1.15; font-variant-numeric: tabular-nums;
        }
        @media (min-width: 800px) {
          .steps > li { grid-template-columns: 4rem minmax(0, 22ch) minmax(0, 1fr); gap: 2.5rem; align-items: baseline; padding: 2rem 0; }
          .steps p { max-width: 52ch; }
        }
      `}</style>
    </section>
  );
}

/** The systems behind it. NOT a sequence, so deliberately not numbered. */
function Systems() {
  const systems = [
    {
      title: "Typography systems",
      body: "Weight, width, contrast, optical sizing and the spacing rules that make a wordmark hold together at 16px and at 16 metres.",
    },
    {
      title: "Symbol libraries",
      body: "Geometric primitives and the construction rules for combining them — tangency, shared radii, consistent stroke terminals.",
    },
    {
      title: "Composition engine",
      body: "Optical alignment rather than mathematical centring, clear-space ratios, and every lockup a brand actually needs.",
    },
    {
      title: "Brand analysis",
      body: "Turns a description of a business into design constraints, so the output is reasoned about rather than sampled.",
    },
  ];

  return (
    <section className="measure" style={{ paddingBlock: "clamp(3.5rem, 7vw, 5.5rem)" }}>
      <SectionHead
        heading="Four systems, not one prompt"
        support="A general image model draws something logo-shaped. A logo is a system: it has to survive one colour, one inch, and one hundred applications."
      />

      <div className="systems">
        {systems.map((system) => (
          <div key={system.title}>
            <h3 style={{ fontSize: "var(--text-h4)" }}>{system.title}</h3>
            <p style={{ marginTop: "0.625rem", color: "var(--color-muted)" }}>{system.body}</p>
          </div>
        ))}
      </div>

      <style>{`
        .systems {
          display: grid; gap: 2.5rem 3rem;
          border-top: 1px solid var(--color-rule); padding-top: 2.5rem;
        }
        @media (min-width: 760px) { .systems { grid-template-columns: 1fr 1fr; } }
      `}</style>
    </section>
  );
}

function Benefits() {
  const benefits = [
    [
      "Free credits, reserved now",
      "Redeem an early-access code and your credits sit on your account until generation opens.",
    ],
    ["First access when models open", "Early-access members get in before general availability."],
    [
      "Pricing locked at launch rates",
      "Whatever the launch price is, early access pays it — not a later one.",
    ],
    ["Direct line to the team", "Your feedback shapes what the models learn to make."],
  ];

  return (
    <section
      style={{
        background: "var(--color-ink)",
        color: "var(--color-paper)",
        paddingBlock: "clamp(3.5rem, 7vw, 5.5rem)",
      }}
    >
      <div className="measure">
        <h2 style={{ fontSize: "var(--text-h2)", maxWidth: "16ch" }}>What early access gets you</h2>

        <div className="benefits">
          {benefits.map(([title, body]) => (
            <div key={title}>
              <h3
                style={{
                  fontSize: "var(--text-lead)",
                  fontFamily: "var(--font-sans)",
                  fontWeight: 600,
                  letterSpacing: 0,
                }}
              >
                {title}
              </h3>
              <p style={{ marginTop: "0.5rem", color: "#b8b2a4" }}>{body}</p>
            </div>
          ))}
        </div>

        <Link to="/auth/signup" className="btn btn-primary" style={{ marginTop: "3rem" }}>
          Reserve your free credits
        </Link>
      </div>

      <style>{`
        .benefits {
          display: grid; gap: 2rem 3rem; margin-top: 3rem;
          padding-top: 2.5rem; border-top: 1px solid #2e2b26;
        }
        @media (min-width: 760px) { .benefits { grid-template-columns: 1fr 1fr; } }
      `}</style>
    </section>
  );
}

export const FAQS = [
  {
    q: "Can Inkloom generate a logo right now?",
    a: "No. The models are in development. You can create an account, join early access and reserve credits today; generation is not enabled yet, and we will email you when it opens.",
  },
  {
    q: "What is a credit?",
    a: "A credit is the unit Inkloom will charge for generation work. One generation will cost a set number of credits. Because generation is not live, nothing consumes credits yet.",
  },
  {
    q: "Do early-access credits expire?",
    a: "No. Credits granted during early access do not expire. If that ever changes we will tell you before it applies, and it will not apply retroactively to credits already granted.",
  },
  {
    q: "Will I have to pay at launch?",
    a: "Not to use your early-access credits. They are yours. Paid plans will exist alongside them, and early-access members get launch pricing.",
  },
  {
    q: "Who owns the logos Inkloom makes?",
    a: "You will. Full commercial rights to the marks generated on your account, with no attribution requirement. The details will be in the terms before generation opens.",
  },
  {
    q: "How is this different from asking an image model for a logo?",
    a: "A general image model produces a picture of a logo — often beautiful, usually unusable: soft edges, unrepeatable, no vector structure, text that is nearly right. Inkloom builds marks from typographic and geometric systems, so what comes out is constructed rather than drawn.",
  },
];

function Faq() {
  return (
    <section className="measure" style={{ paddingBlock: "clamp(3.5rem, 7vw, 5.5rem)" }}>
      <SectionHead heading="Questions people ask" />

      <div style={{ borderTop: "1px solid var(--color-rule)" }}>
        {FAQS.map((faq) => (
          <details
            key={faq.q}
            style={{ borderBottom: "1px solid var(--color-rule-soft)", padding: "1.25rem 0" }}
          >
            <summary
              style={{
                cursor: "pointer",
                fontSize: "var(--text-lead)",
                fontWeight: 600,
                listStyle: "none",
                display: "flex",
                justifyContent: "space-between",
                gap: "1rem",
                alignItems: "center",
              }}
            >
              {faq.q}
              <span
                aria-hidden="true"
                style={{ color: "var(--color-loop)", fontSize: "1.5rem", lineHeight: 1 }}
              >
                +
              </span>
            </summary>
            <p style={{ marginTop: "0.875rem", color: "var(--color-muted)" }}>{faq.a}</p>
          </details>
        ))}
      </div>

      <style>{`
        details > summary::-webkit-details-marker { display: none; }
        details[open] > summary > span { transform: rotate(45deg); }
        details > summary > span { transition: transform 160ms ease; }
      `}</style>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="measure" style={{ paddingBlock: "clamp(3rem, 6vw, 4.5rem)" }}>
      <div
        style={{
          border: "1px solid var(--color-ink)",
          padding: "clamp(2rem, 5vw, 3.5rem)",
        }}
      >
        <h2 style={{ fontSize: "var(--text-h2)", maxWidth: "18ch" }}>
          Be there when the models open.
        </h2>
        <p style={{ marginTop: "1rem", color: "var(--color-muted)", fontSize: "var(--text-lead)" }}>
          Create an account, redeem your code, and your credits are waiting.
        </p>
        <div style={{ display: "flex", gap: "0.75rem", marginTop: "2rem", flexWrap: "wrap" }}>
          <Link to="/auth/signup" className="btn btn-primary">
            Join early access
          </Link>
          <Link to="/how-it-works" className="btn btn-outline">
            Read how it works
          </Link>
        </div>
      </div>
    </section>
  );
}

export function SectionHead({ heading, support }: { heading: string; support?: string }) {
  return (
    <div style={{ marginBottom: "2.5rem" }}>
      <h2 style={{ fontSize: "var(--text-h2)", maxWidth: "20ch" }}>{heading}</h2>
      {support && (
        <p style={{ marginTop: "1rem", color: "var(--color-muted)", fontSize: "var(--text-lead)" }}>
          {support}
        </p>
      )}
    </div>
  );
}

import { Link } from "react-router";
import type { Route } from "./+types/faq";
import { buildMeta, faqJsonLd } from "../../lib/seo";
import { FAQS } from "./home";

const MORE = [
  {
    q: "When will generation actually open?",
    a: "We are not giving a date we cannot keep. The models are in active development; early-access members get emailed the moment the first one opens, before general availability.",
  },
  {
    q: "What format will the logos be?",
    a: "Vector, so they scale without loss and can be edited. Exact export formats will be confirmed before generation opens.",
  },
  {
    q: "Can I use an Inkloom logo commercially?",
    a: "Yes. You will own full commercial rights to marks generated on your account, with no attribution requirement. The precise terms will be published before generation opens.",
  },
  {
    q: "Do you train on my inputs?",
    a: "Not without asking. If we ever want to use customer inputs to improve the models, it will be opt-in, explained plainly, and off by default.",
  },
  {
    q: "How do I delete my account?",
    a: "Email support@inkloom.art and we will do it for you. Deletion removes your personal data and ends every session, and any credits are forfeited; we keep an anonymised accounting record of grants because we are required to, with nothing personal attached.",
  },
  {
    q: "Is there an API?",
    a: "Not in this version. A public API is on the list once generation is stable.",
  },
  {
    q: "I found a security problem. Who do I tell?",
    a: "Please report it to security@inkloom.art. We will acknowledge it, and we will not take action against anyone reporting in good faith.",
  },
];

const ALL = [...FAQS, ...MORE];

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Frequently asked questions",
    description: "What Inkloom is, what it can do today, how credits work, and what comes next.",
    path: location.pathname,
  });
}

export default function Faq() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd(ALL)) }}
      />

      <section className="measure" style={{ paddingBlock: "clamp(3rem, 7vw, 5rem) 2.5rem" }}>
        <h1 style={{ fontSize: "clamp(2.25rem, 5.5vw, var(--text-h1))", maxWidth: "16ch" }}>
          Questions
        </h1>
        <p
          style={{
            marginTop: "1.5rem",
            fontSize: "var(--text-lead)",
            color: "var(--color-ink-soft)",
          }}
        >
          Answered honestly, including the ones with an inconvenient answer.
        </p>
      </section>

      <section className="measure" style={{ paddingBottom: "clamp(3rem, 6vw, 4.5rem)" }}>
        <div style={{ borderTop: "1px solid var(--color-rule)" }}>
          {ALL.map((faq) => (
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

        <p style={{ marginTop: "2.5rem", color: "var(--color-muted)" }}>
          Not answered here? <Link to="/contact">Ask us directly</Link> — a person reads every
          message.
        </p>
      </section>

      <style>{`
        details > summary::-webkit-details-marker { display: none; }
        details[open] > summary > span { transform: rotate(45deg); }
        details > summary > span { transition: transform 160ms ease; }
      `}</style>
    </>
  );
}

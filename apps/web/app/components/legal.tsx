/**
 * Shared shell for the legal documents.
 *
 * One component so the four documents cannot drift apart in structure, and so
 * "last updated" is impossible to forget: it is a required prop.
 *
 * Content is plain data, rendered as text. Nothing here uses
 * `dangerouslySetInnerHTML`.
 */
import { Link } from "react-router";

export interface LegalSection {
  heading: string;
  paragraphs?: string[];
  list?: string[];
}

export function LegalDocument({
  title,
  updated,
  summary,
  sections,
  contact,
}: {
  title: string;
  /** ISO date. Rendered, and used for the machine-readable timestamp. */
  updated: string;
  summary: string;
  sections: LegalSection[];
  contact?: string;
}) {
  return (
    <article
      className="measure"
      style={{ paddingBlock: "clamp(3rem, 7vw, 5rem) clamp(3rem, 6vw, 4.5rem)" }}
    >
      <header style={{ paddingBottom: "1.75rem", borderBottom: "1px solid var(--color-rule)" }}>
        <h1 style={{ fontSize: "clamp(2rem, 5vw, var(--text-h1))", maxWidth: "18ch" }}>{title}</h1>
        <p
          style={{
            marginTop: "1.25rem",
            fontSize: "var(--text-lead)",
            color: "var(--color-ink-soft)",
          }}
        >
          {summary}
        </p>
        <p style={{ marginTop: "1rem", fontSize: "var(--text-fine)", color: "var(--color-muted)" }}>
          Last updated{" "}
          <time dateTime={updated}>
            {new Date(updated).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </time>
        </p>
      </header>

      <div className="legal-body">
        {sections.map((section, index) => (
          <section key={section.heading}>
            <h2>
              <span className="legal-index numeric" aria-hidden="true">
                {index + 1}
              </span>
              {section.heading}
            </h2>
            {section.paragraphs?.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            {section.list && (
              <ul>
                {section.list.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      <footer
        style={{
          marginTop: "3rem",
          paddingTop: "1.75rem",
          borderTop: "1px solid var(--color-rule)",
        }}
      >
        <p style={{ color: "var(--color-muted)" }}>
          {contact ?? "Questions about this document?"} <Link to="/contact">Get in touch</Link>.
        </p>
        <nav
          aria-label="Legal documents"
          style={{
            display: "flex",
            gap: "1.25rem",
            flexWrap: "wrap",
            marginTop: "1rem",
            fontSize: "var(--text-fine)",
          }}
        >
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/cookies">Cookies</Link>
          <Link to="/acceptable-use">Acceptable use</Link>
        </nav>
      </footer>

      <style>{`
        .legal-body { max-width: 68ch; }
        .legal-body section { padding-top: 2.25rem; }
        .legal-body h2 {
          font-size: var(--text-h4); display: flex; gap: 0.75rem; align-items: baseline;
          margin-bottom: 0.875rem;
        }
        .legal-index { color: var(--color-faint); font-size: var(--text-base); }
        .legal-body p { margin-bottom: 0.875rem; color: var(--color-ink-soft); max-width: none; }
        .legal-body ul { margin: 0 0 0.875rem; padding-left: 1.25rem; color: var(--color-ink-soft); }
        .legal-body li { margin-bottom: 0.375rem; }
      `}</style>
    </article>
  );
}

/** Shared across the documents so a change lands in all four. */
export const LEGAL_UPDATED = "2026-09-01";
export const LEGAL_ENTITY = "Inkloom";
export const LEGAL_CONTACT = "support@inkloom.com";

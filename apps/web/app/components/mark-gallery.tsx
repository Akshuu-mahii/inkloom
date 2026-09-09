/**
 * Reference marks.
 *
 * These are hand-constructed SVG specimens illustrating the geometric systems
 * Inkloom's models are being built around — tangency, shared radii, monoline
 * terminals, counter rhythm.
 *
 * They are labelled as reference constructions everywhere they appear, and
 * never as generated output, because generation is not live. Presenting them
 * as model output would be the single most misleading thing this site could
 * do.
 *
 * Drawn as inline SVG rather than raster images: they are a few hundred bytes
 * each, scale perfectly, need no image pipeline, and inherit the page's colours.
 */

interface Mark {
  id: string;
  name: string;
  construction: string;
  render: () => React.ReactNode;
}

const STROKE = 6;

const MARKS: Mark[] = [
  {
    id: "orbit",
    name: "Orbit",
    construction: "Circle + offset arc",
    render: () => (
      <>
        <circle cx="50" cy="50" r="26" fill="none" stroke="currentColor" strokeWidth={STROKE} />
        <path
          d="M 50 12 A 38 38 0 0 1 88 50"
          fill="none"
          stroke="var(--color-loop)"
          strokeWidth={STROKE}
          strokeLinecap="round"
        />
      </>
    ),
  },
  {
    id: "aperture",
    name: "Aperture",
    construction: "Six chords, 60° rotation",
    render: () => (
      <g fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round">
        {[0, 60, 120, 180, 240, 300].map((angle) => (
          <line key={angle} x1="50" y1="22" x2="72" y2="40" transform={`rotate(${angle} 50 50)`} />
        ))}
      </g>
    ),
  },
  {
    id: "ledger",
    name: "Ledger",
    construction: "Stacked rules, 3:2:1 weight",
    render: () => (
      <g stroke="currentColor" strokeLinecap="square">
        <line x1="20" y1="30" x2="80" y2="30" strokeWidth={10} />
        <line x1="20" y1="50" x2="66" y2="50" strokeWidth={7} />
        <line x1="20" y1="70" x2="52" y2="70" strokeWidth={4} stroke="var(--color-loop)" />
      </g>
    ),
  },
  {
    id: "fold",
    name: "Fold",
    construction: "Square, 45° bisect",
    render: () => (
      <>
        <path d="M 22 22 H 78 V 78 H 22 Z" fill="none" stroke="currentColor" strokeWidth={STROKE} />
        <path d="M 22 78 L 78 22" fill="none" stroke="var(--color-loop)" strokeWidth={STROKE} />
      </>
    ),
  },
  {
    id: "counter",
    name: "Counter",
    construction: "Ring, 90° aperture",
    render: () => (
      <path
        d="M 76 50 A 26 26 0 1 1 50 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={12}
        strokeLinecap="butt"
      />
    ),
  },
  {
    id: "prism",
    name: "Prism",
    construction: "Triangle on shared baseline",
    render: () => (
      <>
        <path d="M 50 20 L 80 74 H 20 Z" fill="none" stroke="currentColor" strokeWidth={STROKE} />
        <path d="M 50 44 L 65 74 H 35 Z" fill="var(--color-loop)" stroke="none" />
      </>
    ),
  },
  {
    id: "meridian",
    name: "Meridian",
    construction: "Circle + three latitudes",
    render: () => (
      <g fill="none" stroke="currentColor" strokeWidth={STROKE}>
        <circle cx="50" cy="50" r="28" />
        <line x1="24" y1="40" x2="76" y2="40" />
        <line x1="22" y1="50" x2="78" y2="50" stroke="var(--color-loop)" />
        <line x1="24" y1="60" x2="76" y2="60" />
      </g>
    ),
  },
  {
    id: "quill",
    name: "Quill",
    construction: "Bezier, single stroke",
    render: () => (
      <path
        d="M 26 76 C 26 40 44 24 76 24 C 62 56 44 66 26 76 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    ),
  },
];

export function MarkGallery({ limit }: { limit?: number }) {
  const marks = limit ? MARKS.slice(0, limit) : MARKS;

  return (
    <ul className="mark-grid">
      {marks.map((mark) => (
        <li key={mark.id}>
          <div className="mark-tile">
            <svg
              viewBox="0 0 100 100"
              width="100%"
              height="100%"
              role="img"
              aria-label={`${mark.name}: ${mark.construction}`}
            >
              {mark.render()}
            </svg>
          </div>
          <p className="mark-name">{mark.name}</p>
          <p className="mark-construction">{mark.construction}</p>
        </li>
      ))}

      <style>{`
        .mark-grid {
          list-style: none; margin: 0; padding: 0;
          display: grid; gap: 1px;
          grid-template-columns: repeat(2, 1fr);
          background: var(--color-rule-soft);
          border: 1px solid var(--color-rule-soft);
        }
        .mark-grid > li { background: var(--color-paper); padding: 1.25rem; }
        .mark-tile {
          aspect-ratio: 1; display: grid; place-items: center;
          color: var(--color-ink); padding: 12%;
        }
        .mark-name {
          font-family: var(--font-display); font-weight: 600;
          font-size: var(--text-base); letter-spacing: -0.02em;
          margin-top: 0.5rem;
        }
        .mark-construction {
          font-size: var(--text-micro); color: var(--color-muted); margin-top: 0.125rem;
        }
        @media (min-width: 640px) { .mark-grid { grid-template-columns: repeat(4, 1fr); } }
      `}</style>
    </ul>
  );
}

export const MARK_COUNT = MARKS.length;

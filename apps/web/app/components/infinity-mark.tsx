/**
 * The Inkloom infinity, and the loading state built from it.
 *
 * The mark's own glyph — a true lemniscate drawn as one continuous path,
 * unlike the wordmark's "oo", which is two rings. Inlined rather than loaded
 * as a file so it can inherit colour and be animated; it is small enough that
 * a request for it would cost more than it saves.
 *
 * WHY THIS IS THE LOADING INDICATOR. A spinner is a borrowed shape that says
 * nothing about whose software you are waiting on. This says something true:
 * a loop with no end is what "still working" looks like, and it is already the
 * brand's own figure. One idea, used where it belongs.
 */
import { useId } from "react";

/** The path, traced from the brand artwork; viewBox 487x262. */
const INFINITY_PATH =
  "M0 131C0 58.5 58.5 0.5 131.5 0.5C179.5 0.5 218.5 26.5 244 69L296 157C310.5 178.5 331.5 188.5 " +
  "354.5 188.5C385.5 188.5 409 163.5 409 131C409 98.5 385.5 73.5 354.5 73.5C326.5 73.5 306 90 288 " +
  "116L249 46.5C278 17 313 0.5 355.5 0.5C428.5 0.5 487 58.5 487 131C487 203.5 428.5 261.5 355.5 " +
  "261.5C303.5 261.5 263 235 234 190L188 106C173.5 83 155.5 73.5 132.5 73.5C101.5 73.5 78 98.5 78 " +
  "131C78 163.5 101.5 188.5 132.5 188.5C159.5 188.5 179 171 196 142L235 215.5C207 244 171 261.5 " +
  "131.5 261.5C58.5 261.5 0 203.5 0 131Z";

const ASPECT = 487 / 262;

/** Shared with the construction drawing, which builds the same figure. */
export const INFINITY_ASPECT = ASPECT;
export { INFINITY_PATH };

export function InfinityMark({
  size = 24,
  className,
  title,
}: {
  /** Height in pixels. */
  size?: number;
  className?: string;
  /** Supply one to make the mark meaningful to assistive tech; omit to hide it. */
  title?: string;
}) {
  const id = useId();

  return (
    <svg
      width={Math.round(size * ASPECT)}
      height={size}
      viewBox="0 0 487 262"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        {/* The artwork's own gradient: barely a shift, but it is what keeps the
            orange from reading as flat fill at large sizes. */}
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FF5F20" />
          <stop offset="0.52" stopColor="#FE6124" />
          <stop offset="1" stopColor="#FF6425" />
        </linearGradient>
      </defs>
      <path d={INFINITY_PATH} fill={`url(#${id})`} />
    </svg>
  );
}

/**
 * "Still working", as a figure rather than a spinner.
 *
 * A dash travels the lemniscate once per cycle — the path is continuous, so
 * the travel never restarts visibly and the loop genuinely has no end. The
 * outline of the mark stays faintly present underneath, which keeps it legible
 * as the Inkloom figure rather than an abstract moving line.
 *
 * `aria-live` is deliberately absent: the label beside it is the announcement,
 * and a busy indicator that also speaks produces two.
 */
export function Loading({
  size = 20,
  label = "Loading",
  className,
}: {
  size?: number;
  /** Announced to assistive tech. The visible label, if any, sits beside it. */
  label?: string;
  className?: string;
}) {
  const id = useId();

  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center" }}>
      <svg
        width={Math.round(size * ASPECT)}
        height={size}
        viewBox="0 0 487 262"
        /* An empty label is not "no label" to a screen reader — it is an
           unnamed image. When the caller supplies none, the figure is
           decoration beside text that already says what is happening. */
        role={label ? "img" : undefined}
        aria-label={label || undefined}
        aria-hidden={label ? undefined : true}
        focusable="false"
      >
        <path d={INFINITY_PATH} fill="none" stroke="currentColor" strokeWidth={14} opacity={0.22} />
        <path
          id={id}
          className="infinity-trace"
          d={INFINITY_PATH}
          fill="none"
          stroke="currentColor"
          strokeWidth={14}
          strokeLinecap="round"
          /* Normalised so the dash figures below are percentages of the path
             rather than numbers that would change if the curve were retraced. */
          pathLength={100}
        />
      </svg>
    </span>
  );
}

/**
 * A button's busy state: the figure, then the words.
 *
 * The label is what assistive tech announces — the figure carries `aria-hidden`
 * through `Loading`'s own label being suppressed here, so a screen reader hears
 * "Signing in…" once rather than "Loading, Signing in…".
 */
export function BusyLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
      <Loading size={14} label="" />
      {children}
    </span>
  );
}

/**
 * The mark at display size, drawing itself without end.
 *
 * The supplied artwork is a FILLED silhouette — the path traces the outside of
 * the ribbon and both counters — so stroking it draws the mark's contour
 * rather than its centreline. That is the right reading here: this site's
 * language is a specification sheet, and a contour being struck around a form
 * is what a drawing looks like while it is being made.
 *
 * The figure underneath is the finished mark, held at low opacity so the hero
 * is never empty and never a bare moving line. The travelling dash is the same
 * one the loading state uses, at hero weight: one idea, two sizes.
 *
 * It runs continuously, which is a deliberate exception to this site's rule
 * that motion is triggered rather than ambient — the subject is a loop with no
 * end, and a loop that stops making its own point is the wrong drawing.
 */
export function InfinitySpecimen({
  size = 320,
  className,
}: {
  /** Width in pixels; the height follows the artwork's ratio. */
  size?: number;
  className?: string;
}) {
  const id = useId();

  return (
    <svg
      width={size}
      height={Math.round(size / ASPECT)}
      viewBox="0 0 487 262"
      className={className}
      role="img"
      aria-label="The Inkloom mark: a continuous loop with no end"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FF5F20" />
          <stop offset="0.52" stopColor="#FE6124" />
          <stop offset="1" stopColor="#FF6425" />
        </linearGradient>
      </defs>

      {/* The mark, solid and at full strength — this is the logo, not a
          backdrop for an effect. */}
      <path d={INFINITY_PATH} fill={`url(#${id})`} />

      {/* The drawing of it, which never finishes.
          INK, not paper: the contour runs along the outside of the form, where
          a paper-coloured line is invisible against the page and only appears
          where it crosses the fill — so it flickered in and out rather than
          travelling. Ink reads on both sides of the edge, which is what a
          drawn rule does. */}
      <path
        className="infinity-trace infinity-trace-display"
        d={INFINITY_PATH}
        fill="none"
        stroke="var(--color-ink)"
        strokeWidth={4}
        strokeLinecap="round"
        opacity={0.55}
        pathLength={100}
      />
    </svg>
  );
}

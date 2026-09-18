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
 * The mark at display size, forming itself once as the page arrives.
 *
 * The figure is a single continuous contour, so a thick stroke travelling that
 * contour sweeps across the whole ribbon — outer edge, crossing, counters — in
 * the order the shape is actually drawn. Used as a MASK over the filled mark,
 * that sweep becomes the mark assembling itself from one end to the other,
 * rather than a line crawling around a shape that was already there.
 *
 * It ran continuously before, with an ink line tracing the edge. Two things
 * were wrong with that: the ink read as a stray outline on a mark that has no
 * outline, and a permanent animation in the hero competes with the headline
 * every second the page is open. It plays once, then stops on the mark.
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
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FF5F20" />
          <stop offset="0.52" stopColor="#FE6124" />
          <stop offset="1" stopColor="#FF6425" />
        </linearGradient>

        {/*
          The reveal. White shows the fill through, black hides it, and the
          stroke is 96 against a ribbon 78 wide: enough that the sweep covers
          the form completely, and no wider. At 130 it reached across the
          figure and revealed whole sections at once, so the mark appeared in
          jumps rather than forming. `pathLength` normalises the dash figures to percentages, so the
          timing does not change if the curve is ever retraced.
        */}
        <mask id={`${id}-reveal`} maskUnits="userSpaceOnUse" x="0" y="0" width="487" height="262">
          <path
            className="infinity-form"
            d={INFINITY_PATH}
            fill="none"
            stroke="#fff"
            strokeWidth={96}
            strokeLinecap="round"
            pathLength={100}
          />
        </mask>
      </defs>

      <path d={INFINITY_PATH} fill={`url(#${id}-fill)`} mask={`url(#${id}-reveal)`} />
    </svg>
  );
}

/**
 * The Inkloom wordmark.
 *
 * Set in Jost rather than traced as outlines: Jost is the same geometric
 * construction as the approved mark (perfect-circle bowls, flat-topped arches,
 * a circular tittle), so the letterforms match while the mark stays real text —
 * selectable, searchable, and legible to a screen reader without an alt string.
 *
 * The "oo" is replaced by the infinity loop, which is the mark's one drawn
 * element. It carries `aria-hidden` and the surrounding text supplies the
 * accessible name, so assistive tech reads "inkloom." and never "inkl-loop-m".
 */

export interface LogoProps {
  /** Height of the wordmark in pixels. */
  size?: number;
  /** Draw the loop on mount. Used once, on the homepage hero. */
  animate?: boolean;
  className?: string;
  /** Render the loop in ink instead of orange — for dark or dense contexts. */
  monochrome?: boolean;
}

export function Logo({ size = 28, animate = false, className, monochrome = false }: LogoProps) {
  const loopColor = monochrome ? "currentColor" : "var(--color-loop)";

  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 0,
        fontFamily: "var(--font-display)",
        fontWeight: 500,
        fontSize: size,
        lineHeight: 1,
        letterSpacing: "-0.045em",
        color: "currentColor",
      }}
    >
      {/* The accessible name for the whole lockup. */}
      <span className="sr-only">Inkloom</span>

      <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center" }}>
        inkl
        <InfinityLoop size={size} color={loopColor} animate={animate} />m
        <span style={{ color: loopColor }}>.</span>
      </span>
    </span>
  );
}

/**
 * Two fused circles — the "oo" ligature from the wordmark.
 *
 * Drawn as a single continuous path so it can be animated as one stroke: the
 * loop is literally constructed in front of the viewer, which is the idea the
 * whole homepage is built around.
 */
function InfinityLoop({ size, color, animate }: { size: number; color: string; animate: boolean }) {
  return (
    <svg
      width={size * 1.62}
      height={size}
      viewBox="0 0 81 50"
      aria-hidden="true"
      focusable="false"
      style={{ display: "inline-block", verticalAlign: "middle", marginInline: "-0.02em" }}
    >
      <path
        d={LOOP_PATH}
        fill="none"
        stroke={color}
        strokeWidth={13}
        strokeLinecap="round"
        strokeLinejoin="round"
        /* Normalises the reported length to 100 so the CSS dash animation is
           correct regardless of the curve's real geometry. */
        pathLength={100}
        className={animate ? "loop-path" : undefined}
      />
    </svg>
  );
}

/**
 * The lemniscate.
 *
 * Two lobes of equal radius crossing at the midpoint (40.5, 25) — the "oo" of
 * the wordmark, fused. Written as one continuous closed path, mirrored exactly
 * about the crossing point, so it can be drawn as a single stroke and so the
 * two counters are identical.
 */
const LOOP_PATH = [
  "M 40.5 25",
  // left lobe, anticlockwise from the crossing
  "C 36 13 30 6.5 22 6.5",
  "C 13 6.5 6.5 14.7 6.5 25",
  "C 6.5 35.3 13 43.5 22 43.5",
  "C 30 43.5 36 37 40.5 25",
  // right lobe, the exact mirror
  "C 45 13 51 6.5 59 6.5",
  "C 68 6.5 74.5 14.7 74.5 25",
  "C 74.5 35.3 68 43.5 59 43.5",
  "C 51 43.5 45 37 40.5 25",
  "Z",
].join(" ");

/**
 * The loop on its own, at display scale, with the construction geometry a logo
 * specification sheet would show: the two circles it is built from, their
 * centres, and the baseline. The construction layer is what makes the homepage
 * hero about *how marks are made* rather than a decorative flourish.
 */
export function LoopSpecimen({
  size = 320,
  animate = true,
  showConstruction = true,
}: {
  size?: number;
  animate?: boolean;
  showConstruction?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size * 0.62}
      viewBox="0 0 81 50"
      role="img"
      aria-label="The Inkloom mark: two circles fused into a continuous loop"
    >
      {showConstruction && (
        <g className="construction" aria-hidden="true">
          <circle cx="22" cy="25" r="18.5" />
          <circle cx="59" cy="25" r="18.5" />
          <line x1="0" y1="25" x2="81" y2="25" />
          <line x1="22" y1="3" x2="22" y2="47" />
          <line x1="59" y1="3" x2="59" y2="47" />
          <line x1="40.5" y1="3" x2="40.5" y2="47" />
        </g>
      )}
      <path
        d={LOOP_PATH}
        fill="none"
        stroke="var(--color-loop)"
        strokeWidth={13}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={100}
        className={animate ? "loop-path" : undefined}
      />
    </svg>
  );
}

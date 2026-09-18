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

/**
 * How tall the loop is, as a multiple of the wordmark's font size.
 *
 * The loop stands in for "oo", so it is sized to the x-height, not to the font
 * size. In the artwork the letters' x-height is 438px and the loop is 450px —
 * a 2.7% overshoot, exactly what a round glyph gets so it does not read as
 * short beside flat-topped ones.
 *
 * Jost's x-height at weight 700 measures 0.460em — taken from the font itself
 * via canvas metrics, not from the 0.535 the specimen sheet implies, which was
 * wrong by 16%. So:
 *
 *     0.460 x 1.027 = 0.472
 */
const LOOP_HEIGHT_EM = 0.516;

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
        /* The artwork's stems are 137px against a 438px x-height — a ratio of
           0.31, which is as heavy as the variable face goes. */
        fontWeight: 700,
        fontSize: size,
        lineHeight: 1,
        letterSpacing: "-0.042em",
        color: "currentColor",
      }}
    >
      {/* The accessible name for the whole lockup. */}
      <span className="sr-only">Inkloom</span>

      <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "baseline" }}>
        inkl
        <InfinityLoop size={size} color={loopColor} animate={animate} />m
        {/*
          The full stop is INK, not orange.

          Sampling the artwork settles it: there is not one orange pixel to the
          right of the loop. Orange belongs to the loop alone, which is what
          makes it read as the mark rather than as decoration.
        */}
        <span>.</span>
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
      width={size * LOOP_HEIGHT_EM * LOOP_ASPECT}
      height={size * LOOP_HEIGHT_EM}
      viewBox={LOOP_VIEWBOX}
      aria-hidden="true"
      focusable="false"
      /*
        Sat on the baseline like the letters it replaces, then dropped by the
        overshoot so its underside lines up with theirs.

        Nudged with `top`, not with a negative bottom margin: the parent is a
        flex container, and a flex item's baseline alignment ignores the margin,
        so the margin version moved nothing at all. Relative offset shifts the
        paint without disturbing the layout either way.
      */
      style={{
        display: "inline-block",
        position: "relative",
        top: "0.039em",
        marginInline: "-0.012em",
      }}
    >
      <LoopRings color={color} animate={animate} />
    </svg>
  );
}

/**
 * The loop, measured off the approved artwork — and drawn the way the artwork
 * is actually built.
 *
 * IT IS TWO RINGS, NOT A FIGURE-EIGHT. This file used to carry a hand-written
 * bezier figure-eight: one continuous path that looped left, crossed, and
 * looped right. The measurements were right and the curve was not — its
 * crossing pinched the right lobe's counter into a lopsided teardrop, which at
 * hero size is the first thing anyone sees and at header size turns the mark
 * into an orange blob.
 *
 * The real construction is simpler and it is what the wordmark says it is: two
 * circles, stroked heavily enough that their strokes merge where they overlap.
 * The counters stay perfectly circular because they ARE circles, and the
 * junction shapes itself.
 *
 * Every number is sampled from `inkloom.png` (3552x1184), expressed in a
 * 840x450 viewBox — the mark's true aspect ratio of 1.867:
 *
 *   outer diameter      450         (so outer radius 225)
 *   ring thickness      134
 *   centreline radius   158         (225 - 134/2)
 *   counter radius       91         (158 - 134/2)
 *   lobe centres        x 225, 615  at y 225
 *
 * The centres sit 390 apart, which is more than 2x158, so the CENTRELINES do
 * not touch — but the strokes, 134 wide, overlap by 60. That overlap is the
 * crossing.
 */
export const LOOP_VIEWBOX = "0 0 840 450";
export const LOOP_ASPECT = 840 / 450;
export const LOOP_STROKE = 134;
export const LOOP_RADIUS = 158;
export const LOOP_CENTRES = [225, 615] as const;
export const LOOP_CY = 225;

/**
 * The rings as path data, for the one caller that animates them along a
 * timeline. The mark itself uses <circle>: an arc path has a start and an end,
 * and at this stroke width the join between them shows as a hairline wedge
 * through the top of the ring — visible at hero size, which is exactly where
 * it must not be.
 */
export const LOOP_PATHS = LOOP_CENTRES.map(
  (cx) =>
    `M ${cx} ${LOOP_CY - LOOP_RADIUS}` +
    ` A ${LOOP_RADIUS} ${LOOP_RADIUS} 0 1 1 ${cx - 0.01} ${LOOP_CY - LOOP_RADIUS} Z`,
);

/** Kept for callers that want one `d`; the rings are separate subpaths. */
export const LOOP_PATH = LOOP_PATHS.join(" ");

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
      height={size / LOOP_ASPECT}
      viewBox={LOOP_VIEWBOX}
      role="img"
      aria-label="The Inkloom mark: two circles fused into a continuous loop"
    >
      {showConstruction && (
        /* The real construction: two circles of radius 158 whose centres sit
           390 apart, and the vertical through the crossing at x = 420. */
        <g className="construction" aria-hidden="true">
          <circle cx="225" cy="225" r="158" />
          <circle cx="615" cy="225" r="158" />
          <line x1="0" y1="225" x2="840" y2="225" />
          <line x1="225" y1="30" x2="225" y2="420" />
          <line x1="615" y1="30" x2="615" y2="420" />
          <line x1="420" y1="30" x2="420" y2="420" />
        </g>
      )}
      <LoopRings color="var(--color-loop)" animate={animate} />
    </svg>
  );
}

/**
 * The two rings, painted.
 *
 * `paint-order: stroke` is not needed and no fill is used: two strokes of the
 * same colour meeting simply merge, which is exactly what the artwork does.
 * Round caps would be visible if a ring were ever partially drawn, so the
 * animated state starts each ring from the top and closes it.
 */
function LoopRings({ color, animate }: { color: string; animate: boolean }) {
  return (
    <g>
      {LOOP_CENTRES.map((cx, i) => (
        <circle
          key={cx}
          cx={cx}
          cy={LOOP_CY}
          r={LOOP_RADIUS}
          fill="none"
          stroke={color}
          strokeWidth={LOOP_STROKE}
          /* Normalises the reported length to 100 so a dash animation runs at
             the same rate on both rings. */
          pathLength={100}
          className={animate ? "loop-path" : undefined}
          style={animate ? { animationDelay: `${i * 0.18}s` } : undefined}
        />
      ))}
    </g>
  );
}

/**
 * The Inkloom wordmark, from the approved artwork.
 *
 * It used to be set in Jost with a drawn loop standing in for the "oo" — real
 * text, selectable and searchable, on the theory that Jost's geometry matched
 * the mark closely enough. It did not: at header size the reconstruction read
 * as an orange blob rather than the mark, and a wordmark that is nearly right
 * is worse than one that is plainly someone else's.
 *
 * So the artwork itself ships. `alt="Inkloom"` carries the accessible name, and
 * the two files are the same drawing keyed out of its cream background:
 *
 *   logo-wordmark.png       ink letters, orange loop — everywhere
 *   logo-wordmark-mono.png  entirely ink — for dense or inverted contexts
 *
 * The alpha channel was computed per pixel rather than colour-keyed, so the
 * anti-aliased edges survive against any background instead of fringing cream.
 *
 * The CONSTRUCTION drawings below are unaffected and stay vector: they are
 * about how a mark is built, they animate, and they are the subject of the
 * homepage and the how-it-works page rather than the brand signature.
 */

export interface LogoProps {
  /** Height of the wordmark in pixels. */
  size?: number;
  /** Accepted and ignored: the image does not draw itself. */
  animate?: boolean;
  className?: string;
  /** Render the loop in ink instead of orange — for dense, single-colour contexts. */
  monochrome?: boolean;
  /**
   * Paper letters instead of ink, for the ink-coloured panels.
   *
   * Not cosmetic: the auth screens put the wordmark on `--color-ink`, where
   * ink letters are invisible and only the orange loop survives — which is
   * what shipped, and read as a bare orange squiggle in the corner of every
   * sign-in page. The loop stays orange, because the loop is the brand.
   */
  invert?: boolean;
}

/**
 * `size` is now the wordmark's HEIGHT, which is what it should always have
 * meant. It used to be the lockup's font size, from which the visible mark
 * came out about a third smaller — so the same numbers rendered a wordmark
 * that sat noticeably below the weight of the navigation beside it.
 */
const WORDMARK_ASPECT = 790 / 160;

export function Logo({ size = 28, className, monochrome = false, invert = false }: LogoProps) {
  const height = size;
  const src = monochrome
    ? "/logo-wordmark-mono.png"
    : invert
      ? "/logo-wordmark-invert.png"
      : "/logo-wordmark.png";

  return (
    <img
      src={src}
      alt="Inkloom"
      className={className}
      width={Math.round(height * WORDMARK_ASPECT)}
      height={height}
      /* Explicit dimensions AND a height in the style: the attributes reserve
         the space before the image arrives, which keeps the header from
         reflowing, and the style keeps it exact if a stylesheet sets a
         max-width on images — which this one does. */
      style={{ height, width: "auto", display: "block" }}
      decoding="async"
      /* The wordmark is in the header of every page, so it is never lazy: a
         deferred logo is a visibly empty header on the first paint. */
      loading="eager"
      draggable={false}
    />
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

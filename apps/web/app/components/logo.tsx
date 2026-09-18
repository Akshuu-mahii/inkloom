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

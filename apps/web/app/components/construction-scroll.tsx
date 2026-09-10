/**
 * The scroll-linked construction sequence.
 *
 * The one scroll-driven animation on the site, and the only place GSAP is
 * loaded. It shows the Inkloom mark being CONSTRUCTED as you read the four
 * pipeline stages: guides first, then the circles, then the stroke. That is the
 * page's actual subject matter, which is the bar a scroll animation has to
 * clear — a fade-and-slide-up on each section would be decoration, and would
 * read as filler.
 *
 * Everything expensive is conditional:
 *
 *   - GSAP and ScrollTrigger are imported dynamically, so the ~33 KB never
 *     reaches a visitor who does not open this page, and never reaches the
 *     signed-in dashboard at all.
 *   - Nothing loads for `prefers-reduced-motion`; the mark renders complete.
 *   - The timeline is scrubbed by scroll position rather than played, so it is
 *     driven entirely by the reader and consumes nothing while off-screen.
 *   - Everything is reverted on unmount, so a client-side navigation cannot
 *     leak a ScrollTrigger or a RAF loop.
 */
import { useEffect, useRef, useState } from "react";
import { LOOP_ASPECT, LOOP_PATH, LOOP_STROKE, LOOP_VIEWBOX } from "./logo";

export function ConstructionScroll({ children }: { children: React.ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !container.current) return;

    let cleanup: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const [{ gsap }, { ScrollTrigger }] = await Promise.all([
        import("gsap"),
        import("gsap/ScrollTrigger"),
      ]);
      if (cancelled || !container.current) return;

      gsap.registerPlugin(ScrollTrigger);
      setEnabled(true);

      const scope = container.current;
      const context = gsap.context(() => {
        const guides = scope.querySelectorAll<SVGElement>("[data-build='guide']");
        const circles = scope.querySelectorAll<SVGElement>("[data-build='circle']");
        const stroke = scope.querySelector<SVGPathElement>("[data-build='stroke']");

        const timeline = gsap.timeline({
          scrollTrigger: {
            trigger: scope,
            start: "top 70%",
            end: "bottom 60%",
            // Scrubbed: the reader drives it, so it never plays on its own and
            // never competes for attention while they are reading.
            scrub: 0.6,
          },
        });

        timeline
          .fromTo(guides, { opacity: 0 }, { opacity: 1, duration: 0.6, stagger: 0.08 })
          .fromTo(
            circles,
            { opacity: 0, scale: 0.94, transformOrigin: "center" },
            { opacity: 1, scale: 1, duration: 0.8, stagger: 0.12 },
            "<0.2",
          )
          .fromTo(stroke, { strokeDashoffset: 100 }, { strokeDashoffset: 0, duration: 1.6 }, "<0.3")
          .to(guides, { opacity: 0.45, duration: 0.5 }, "<0.8");
      }, scope);

      cleanup = () => context.revert();
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return (
    <div ref={container} data-construction={enabled ? "animated" : "static"}>
      {children}
      <style>{`
        /* Until GSAP takes over — and permanently, for reduced motion or if the
           import fails — the mark is simply drawn complete. Nothing depends on
           JavaScript arriving. */
        [data-construction="animated"] [data-build="stroke"] { stroke-dasharray: 100; }
      `}</style>
    </div>
  );
}

/**
 * The mark, marked up so the timeline can address its parts.
 *
 * Static and complete on its own; the attributes are inert without GSAP.
 */
export function ConstructionMark({ size = 340 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size / LOOP_ASPECT}
      viewBox={LOOP_VIEWBOX}
      role="img"
      aria-label="The Inkloom mark, constructed from two circles"
    >
      <g className="construction">
        <line data-build="guide" x1="0" y1="225" x2="840" y2="225" />
        <line data-build="guide" x1="225" y1="30" x2="225" y2="420" />
        <line data-build="guide" x1="615" y1="30" x2="615" y2="420" />
        <line data-build="guide" x1="420" y1="30" x2="420" y2="420" />
        <circle data-build="circle" cx="225" cy="225" r="158" />
        <circle data-build="circle" cx="615" cy="225" r="158" />
      </g>
      <path
        data-build="stroke"
        d={LOOP_PATH}
        fill="none"
        stroke="var(--color-loop)"
        strokeWidth={LOOP_STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={100}
      />
    </svg>
  );
}

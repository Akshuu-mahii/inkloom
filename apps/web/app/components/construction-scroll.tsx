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
      height={size * 0.62}
      viewBox="0 0 81 50"
      role="img"
      aria-label="The Inkloom mark, constructed from two circles"
    >
      <g className="construction">
        <line data-build="guide" x1="0" y1="25" x2="81" y2="25" />
        <line data-build="guide" x1="22" y1="3" x2="22" y2="47" />
        <line data-build="guide" x1="59" y1="3" x2="59" y2="47" />
        <line data-build="guide" x1="40.5" y1="3" x2="40.5" y2="47" />
        <circle data-build="circle" cx="22" cy="25" r="18.5" />
        <circle data-build="circle" cx="59" cy="25" r="18.5" />
      </g>
      <path
        data-build="stroke"
        d="M 40.5 25 C 36 13 30 6.5 22 6.5 C 13 6.5 6.5 14.7 6.5 25 C 6.5 35.3 13 43.5 22 43.5 C 30 43.5 36 37 40.5 25 C 45 13 51 6.5 59 6.5 C 68 6.5 74.5 14.7 74.5 25 C 74.5 35.3 68 43.5 59 43.5 C 51 43.5 45 37 40.5 25 Z"
        fill="none"
        stroke="var(--color-loop)"
        strokeWidth={13}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={100}
      />
    </svg>
  );
}

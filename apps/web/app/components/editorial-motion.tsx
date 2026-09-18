/**
 * The site's one motion idea: rules draw themselves.
 *
 * A spec sheet is measured before it is drawn, so the hairlines that divide
 * this site are not decoration — they are the measure. Animating them is the
 * only scroll motion here that says something about the subject: each rule
 * extends from its left edge as the row beneath it comes into reading range,
 * the way a rule is struck across a drawing before the drawing is made.
 *
 * WHAT THIS DELIBERATELY IS NOT: a fade-and-slide-up on every section. That
 * treatment is applied to any content whatsoever, which is precisely why it
 * reads as filler — it draws attention to arrival rather than to what arrived.
 * One idea, used consistently, on one class of element.
 *
 * Everything costly is conditional, as with the construction sequence:
 *
 *   - GSAP is imported dynamically, so a visitor who never reaches a marketing
 *     page never downloads it, and the signed-in app never sees it at all.
 *   - Nothing runs under `prefers-reduced-motion`; rules render at full width.
 *   - Triggers are reverted on unmount, so a client-side navigation cannot
 *     leak a ScrollTrigger or leave an element stuck at scaleX(0).
 */
import { useEffect } from "react";

/**
 * Animates every `[data-rule]` inside `root` once, as it enters.
 *
 * Pass a ref rather than scanning the document: a page can mount while another
 * is still leaving, and a global selector would claim the outgoing page's
 * elements too.
 */
export function useDrawnRules(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let cleanup: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const [{ gsap }, { ScrollTrigger }] = await Promise.all([
        import("gsap"),
        import("gsap/ScrollTrigger"),
      ]);
      if (cancelled) return;

      gsap.registerPlugin(ScrollTrigger);

      const context = gsap.context(() => {
        const rules = gsap.utils.toArray<HTMLElement>("[data-rule]");
        if (rules.length === 0) return;

        gsap.set(rules, { scaleX: 0, transformOrigin: "left center" });
        rules.forEach((rule) => {
          gsap.to(rule, {
            scaleX: 1,
            duration: 0.55,
            ease: "power3.out",
            scrollTrigger: {
              trigger: rule,
              // Fires when the rule is a comfortable distance above the fold,
              // so the line is already struck by the time the eye arrives.
              start: "top 92%",
              once: true,
            },
          });
        });
      }, node);

      cleanup = () => context.revert();
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [root]);
}

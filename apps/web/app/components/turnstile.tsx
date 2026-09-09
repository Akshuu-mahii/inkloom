/**
 * Cloudflare Turnstile widget.
 *
 * The script is loaded only on the pages that render this component, and the
 * CSP in the Worker only permits `challenges.cloudflare.com` on those same
 * paths — so a script-injection anywhere else has no permitted host to reach.
 *
 * The widget writes its token into a hidden input named `cf-turnstile-response`,
 * which the server action forwards for verification. The SITE key here is
 * public by design; the secret key never reaches the browser.
 *
 * Rendering without JavaScript leaves the token empty. That is handled by the
 * server: a missing token is a failed verification, not a silent pass.
 */
import { useEffect, useRef } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, options: Record<string, unknown>) => string;
      remove: (id: string) => void;
    };
  }
}

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export function Turnstile({
  siteKey,
  action,
  onReady,
}: {
  siteKey: string;
  action?: string;
  /**
   * Fires when a token is available (or when the challenge fails).
   *
   * The form uses this to keep its submit button disabled until verification
   * has actually produced a token. Without it, a fast typist submits in under
   * the ~2-3 seconds the widget needs, sends an empty token, and gets a
   * confusing "we couldn't verify you're human" error for doing nothing wrong.
   */
  onReady?: (ready: boolean) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    function render() {
      if (cancelled || !container.current || !window.turnstile || widgetId.current) return;
      widgetId.current = window.turnstile.render(container.current, {
        sitekey: siteKey,
        action,
        theme: "light",
        // Managed mode: most people never see a challenge at all.
        appearance: "interaction-only",
        callback: () => onReady?.(true),
        "error-callback": () => onReady?.(false),
        // A token is single-use and short-lived; re-run rather than submit a
        // stale one.
        "expired-callback": () => onReady?.(false),
        "timeout-callback": () => onReady?.(false),
      });
    }

    if (window.turnstile) {
      render();
    } else if (!document.getElementById(SCRIPT_ID)) {
      const script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = render;
      document.head.appendChild(script);
    } else {
      document.getElementById(SCRIPT_ID)?.addEventListener("load", render);
    }

    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        window.turnstile.remove(widgetId.current);
        widgetId.current = null;
      }
    };
  }, [siteKey, action, onReady]);

  return (
    <div>
      <div ref={container} />
      <noscript>
        <p className="field-hint">
          This form needs JavaScript to verify you are not a bot. Enable it, or{" "}
          <a href="/contact">contact support</a> and we will help you another way.
        </p>
      </noscript>
    </div>
  );
}

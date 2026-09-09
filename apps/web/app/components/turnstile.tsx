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
 *
 * ---
 *
 * `challenges.cloudflare.com` is a third party, and forms gate their submit
 * button on it. An ad-blocker, a DNS filter, a corporate proxy or a bad minute
 * of connectivity all end the same way: no token, ever. An unbounded wait turns
 * that into a greyed-out button reading "Checking you're human…" forever, with
 * no error and no way forward — which is a broken product as far as the person
 * in front of it is concerned.
 *
 * So the wait is bounded, script failure is detected rather than ignored, and
 * giving up is visible and retryable. The SERVER still fails closed on a
 * missing token; none of this weakens verification, it only stops the UI from
 * stranding someone in front of a control that will never enable.
 */
import { useCallback, useEffect, useRef, useState } from "react";

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

/**
 * How long to hold the submit button before deciding the check is not coming.
 *
 * The widget normally settles in two or three seconds. Ten leaves generous room
 * for a slow connection while staying well inside the time a person will wait
 * before concluding the page is broken.
 */
const GIVE_UP_AFTER_MS = 10_000;

/**
 * `pending`  — still working; the form should hold its submit button.
 * `verified` — a token exists; submitting will pass verification.
 * `unavailable` — the check could not run. The form should stop blocking, so
 *   the person gets an honest server-side refusal they can act on rather than
 *   an inert button. It does NOT mean verification was skipped.
 */
export type TurnstileStatus = "pending" | "verified" | "unavailable";

export function Turnstile({
  siteKey,
  action,
  onStatusChange,
}: {
  siteKey: string;
  action?: string;
  /**
   * Fires whenever the state of the check changes.
   *
   * Forms use this to keep the submit button disabled while the answer is still
   * `pending`. Without it, a fast typist submits in under the two or three
   * seconds the widget needs, sends an empty token, and gets a confusing "we
   * couldn't verify you're human" error for doing nothing wrong.
   */
  onStatusChange?: (status: TurnstileStatus) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [status, setStatus] = useState<TurnstileStatus>("pending");
  const [attempt, setAttempt] = useState(0);

  // Held in a ref so a parent passing an inline arrow function cannot cause the
  // effect to tear the widget down and rebuild it on every render.
  const notify = useRef(onStatusChange);
  notify.current = onStatusChange;

  const report = useCallback((next: TurnstileStatus) => {
    setStatus(next);
    notify.current?.(next);
  }, []);

  const retry = useCallback(() => {
    // Drop the old script so a transient failure gets a genuinely fresh fetch
    // rather than the browser's cached failure.
    document.getElementById(SCRIPT_ID)?.remove();
    report("pending");
    setAttempt((n) => n + 1);
  }, [report]);

  useEffect(() => {
    let cancelled = false;
    const script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;

    function fail() {
      if (cancelled) return;
      report("unavailable");
    }

    function render() {
      if (cancelled || !container.current || widgetId.current) return;
      if (!window.turnstile) {
        // The script reported success but left nothing behind — what a blocker
        // that answers with an empty 200 looks like. Waiting longer is futile.
        fail();
        return;
      }
      try {
        widgetId.current = window.turnstile.render(container.current, {
          sitekey: siteKey,
          action,
          theme: "light",
          // Managed mode: most people never see a challenge at all.
          appearance: "interaction-only",
          callback: () => report("verified"),
          "error-callback": () => fail(),
          // A token is single-use and short-lived; re-run rather than submit a
          // stale one. Back to pending, not unavailable — the widget is working.
          "expired-callback": () => report("pending"),
          "timeout-callback": () => fail(),
        });
      } catch {
        fail();
      }
    }

    // The backstop that matters: whatever else happens — a request that hangs
    // rather than erroring, a callback that never fires, a widget that renders
    // and then goes quiet — the button is released after this.
    const giveUpTimer = setTimeout(() => {
      if (cancelled) return;
      setStatus((current) => {
        if (current === "verified") return current;
        notify.current?.("unavailable");
        return "unavailable";
      });
    }, GIVE_UP_AFTER_MS);

    if (window.turnstile) {
      render();
    } else if (!script) {
      const el = document.createElement("script");
      el.id = SCRIPT_ID;
      el.src = SCRIPT_SRC;
      el.async = true;
      el.defer = true;
      el.addEventListener("load", render);
      // The handler whose absence caused the hang: a blocked or unreachable
      // script fires `error`, never `load`.
      el.addEventListener("error", fail);
      document.head.appendChild(el);
    } else {
      // A tag from an earlier page. It may still be in flight, or it may have
      // already finished — in which case neither event will fire again, so the
      // give-up timer above is what releases the button.
      script.addEventListener("load", render);
      script.addEventListener("error", fail);
    }

    return () => {
      cancelled = true;
      clearTimeout(giveUpTimer);
      document.getElementById(SCRIPT_ID)?.removeEventListener("load", render);
      document.getElementById(SCRIPT_ID)?.removeEventListener("error", fail);
      if (widgetId.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetId.current);
        } catch {
          // Already gone; nothing to clean up.
        }
        widgetId.current = null;
      }
    };
  }, [siteKey, action, attempt, report]);

  return (
    <div>
      <div ref={container} />

      {status === "unavailable" && (
        <div role="alert" className="field-hint" style={{ marginTop: "0.5rem" }}>
          <p style={{ margin: 0 }}>
            The human check didn&rsquo;t load. An ad-blocker or a strict network can stop it. You
            can still send this — if it is refused, allow <code>challenges.cloudflare.com</code> and
            try once more.
          </p>
          <p style={{ margin: "0.375rem 0 0" }}>
            <button
              type="button"
              onClick={retry}
              className="link-button"
              style={{
                background: "none",
                border: 0,
                padding: 0,
                font: "inherit",
                color: "inherit",
                textDecoration: "underline",
                cursor: "pointer",
              }}
            >
              Try the check again
            </button>{" "}
            &middot; <a href="/contact">contact support</a>
          </p>
        </div>
      )}

      <noscript>
        <p className="field-hint">
          This form needs JavaScript to verify you are not a bot. Enable it, or{" "}
          <a href="/contact">contact support</a> and we will help you another way.
        </p>
      </noscript>
    </div>
  );
}

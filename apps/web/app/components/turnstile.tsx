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
 * How long one attempt gets before it is abandoned and retried.
 *
 * The widget normally settles in two or three seconds, but the CDN is a third
 * party and a cold, slow or congested connection can take much longer. This is
 * a per-attempt budget, not a verdict: expiring it starts a fresh attempt.
 */
const ATTEMPT_TIMEOUT_MS = 8_000;

/**
 * How many times to fetch the script before reporting failure.
 *
 * Real evidence for retrying rather than giving up: on a slow connection here,
 * two submissions eight and four seconds apart were both refused with
 * `missing-input-response` — an empty token — and the widget then produced a
 * perfectly good one about forty seconds after load. A single short deadline
 * turns a slow success into a hard failure.
 */
const MAX_ATTEMPTS = 3;

/**
 * `pending`  — still working, or retrying; the form holds its submit button.
 * `verified` — a token exists; submitting will pass verification.
 * `unavailable` — every attempt failed.
 *
 * A form must keep its submit button DISABLED for both `pending` and
 * `unavailable`, and say why. This is a reversal of an earlier decision here,
 * and the reason is worth recording: releasing the button on `unavailable`
 * looked kinder, but the server fails closed on a missing token, so every one
 * of those submissions was refused — with "We couldn't verify that you're
 * human", which reads as an accusation for something entirely outside the
 * person's control. A disabled button beside a clear explanation and a retry is
 * both more honest and less alarming than a live button that cannot work.
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

  /** Manual retry, after the automatic ones are spent. */
  const retry = useCallback(() => {
    // Drop the old script so this gets a genuinely fresh fetch rather than the
    // browser's cached failure.
    document.getElementById(SCRIPT_ID)?.remove();
    report("pending");
    // Back to zero so the manual retry gets the full run of attempts too.
    setAttempt(0);
  }, [report]);

  useEffect(() => {
    let cancelled = false;
    let settled = false;
    const script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;

    /** This attempt did not produce a widget. Try again, or give up. */
    function attemptFailed() {
      if (cancelled || settled) return;
      settled = true;
      clearTimeout(attemptTimer);
      if (attempt + 1 < MAX_ATTEMPTS) {
        // Drop the script so the next attempt refetches rather than replaying
        // the browser's cached failure.
        document.getElementById(SCRIPT_ID)?.remove();
        setAttempt((n) => n + 1);
        return;
      }
      report("unavailable");
    }

    function render() {
      if (cancelled || !container.current || widgetId.current) return;
      if (!window.turnstile) {
        // The script reported success but left nothing behind — what a blocker
        // answering with an empty 200 looks like.
        attemptFailed();
        return;
      }
      try {
        /*
         * Once the widget is up, the attempt has done its job.
         *
         * The timer used to run until a TOKEN arrived, which is a different and
         * much later event: an interaction-only widget can take well over eight
         * seconds to produce one, especially on a cold load where the challenge
         * itself has to be fetched. So a perfectly healthy widget was being torn
         * down and retried three times, and the form then declared the check
         * unavailable — while a refresh, served from cache, beat the timer and
         * looked fine. Stopping the clock here is the fix.
         *
         * Nothing is left unguarded: Turnstile's own `error-callback` and
         * `timeout-callback` cover a widget that renders and then fails, which
         * is what they exist for.
         */
        clearTimeout(attemptTimer);
        widgetId.current = window.turnstile.render(container.current, {
          sitekey: siteKey,
          action,
          theme: "light",
          /*
           * Always visible, not "interaction-only".
           *
           * Interaction-only renders NOTHING unless Cloudflare decides a
           * challenge is warranted, which is quieter but leaves the person with
           * no idea whether anything is happening — and, when the check is
           * genuinely slow, no idea why the submit button is disabled. The
           * widget's own "Success! You are human" tick is the feedback, and it
           * costs one small box above the button.
           *
           * It also makes a broken check obvious to US rather than silent: an
           * empty space is indistinguishable from a widget that never rendered.
           */
          appearance: "always",
          callback: () => {
            settled = true;
            report("verified");
          },
          "error-callback": () => attemptFailed(),
          /*
            A token is single-use and short-lived. Going back to `pending`
            re-blocks the button, which is right: submitting an expired token
            fails exactly like submitting none. Turnstile refreshes it on its
            own, and the callback moves us back to `verified`.
          */
          "expired-callback": () => report("pending"),
          "timeout-callback": () => attemptFailed(),
        });
      } catch {
        attemptFailed();
      }
    }

    /*
      Per-attempt budget. Expiring it is not a verdict — it starts another
      attempt, and only the last one reports failure. A slow CDN should cost a
      few extra seconds, not the ability to sign up.
    */
    /*
      Declared here, referenced by the two functions above.
      Both are function declarations, so they are hoisted, and neither can run
      before this line: the listeners that call them are attached below it.
    */
    const attemptTimer = setTimeout(attemptFailed, ATTEMPT_TIMEOUT_MS);

    if (window.turnstile) {
      render();
    } else if (!script) {
      const el = document.createElement("script");
      el.id = SCRIPT_ID;
      el.src = SCRIPT_SRC;
      el.async = true;
      el.defer = true;
      el.addEventListener("load", render);
      // The handler whose absence caused the original hang: a blocked or
      // unreachable script fires `error`, never `load`.
      el.addEventListener("error", attemptFailed);
      document.head.appendChild(el);
    } else {
      // A tag from an earlier page. It may still be in flight, or it may have
      // already finished — in which case neither event fires again, and the
      // attempt timer is what moves things along.
      script.addEventListener("load", render);
      script.addEventListener("error", attemptFailed);
    }

    return () => {
      cancelled = true;
      clearTimeout(attemptTimer);
      const el = document.getElementById(SCRIPT_ID);
      el?.removeEventListener("load", render);
      el?.removeEventListener("error", attemptFailed);
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
            The human check couldn&rsquo;t load, so this form can&rsquo;t be sent yet. It is not
            something you did. An ad-blocker, a VPN or a strict network can block{" "}
            <code>challenges.cloudflare.com</code> — allow it, or try a different connection.
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

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
 * WHAT THIS COMPONENT IS ACTUALLY FOR.
 *
 * `challenges.cloudflare.com` is a third party, and forms gate their submit
 * button on it. So the job here is to reach a SETTLED, HONEST answer about the
 * check — verified, waiting on the person, or genuinely unavailable — within a
 * bounded time, in every case, including the ones where Turnstile simply stops
 * talking to us.
 *
 * That last case is not hypothetical. It is the bug this file has now shipped
 * twice, in opposite directions:
 *
 *   1. An unbounded wait: the script tag had a `load` handler and no `error`
 *      handler, so a blocked script left the button disabled forever reading
 *      "Checking you're human…" with no error and no way forward.
 *
 *   2. Correcting that with ONE deadline that ran until a TOKEN arrived, which
 *      tore down healthy-but-slow widgets and declared the check dead.
 *
 *   3. Correcting THAT by stopping the clock as soon as the widget rendered —
 *      which removed the last deadline in the system. From that moment the only
 *      things that could move the status were Turnstile's own callbacks, so a
 *      challenge that stalled, or a token that expired and never came back, sat
 *      on "Checking you're human…" indefinitely. Refreshing landed in the same
 *      place, because the cause travels with the person's network, not the tab.
 *
 * The answer to all three is that "the widget appeared" and "a token arrived"
 * are different events that deserve different deadlines, and that "Turnstile is
 * waiting for the PERSON" is a third state that deserves no deadline at all —
 * only a button that says so.
 */
import { useCallback, useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, options: Record<string, unknown>) => string;
      remove: (id: string) => void;
      reset: (id?: string) => void;
    };
  }
}

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * How long the SCRIPT and the WIDGET get before the attempt is abandoned.
 *
 * Deliberately short, because this covers only "did Cloudflare's code load and
 * draw something". It is a per-attempt budget, not a verdict: expiring it starts
 * a fresh attempt.
 */
const WIDGET_TIMEOUT_MS = 8_000;

/**
 * How long a RENDERED widget gets to produce a token.
 *
 * A separate and much longer budget, because it covers a different event.
 * Measured evidence from this project: on a slow connection a widget that had
 * rendered promptly went on to mint a perfectly good token about forty seconds
 * after load. Anything near the widget budget turns that into a false failure —
 * which is exactly the regression that led to removing the deadline entirely.
 *
 * Sixty seconds is comfortably past that observation and still far short of the
 * time a person will sit in front of a dead button wondering what to do.
 *
 * This clock does NOT run while Turnstile is waiting for the person to answer
 * an interactive challenge. See `sawInteractive` below.
 */
const TOKEN_TIMEOUT_MS = 60_000;

/**
 * The second and last budget, after the stalled challenge has been reset.
 *
 * Shorter than the first because everything is warm by now: the script is
 * parsed, the widget is mounted, and `reset()` asks only for a fresh challenge.
 * The pair puts a hard ceiling of ninety seconds on reaching a verdict.
 */
const TOKEN_RETRY_TIMEOUT_MS = 30_000;

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
 * `pending`     — WE are waiting on Turnstile. A deadline is running.
 * `interactive` — TURNSTILE is waiting on the person. No deadline: the clock is
 *                 theirs, and timing them out would be both rude and wrong.
 * `verified`    — a token exists; submitting will pass verification.
 * `unavailable` — every attempt failed.
 *
 * A form must keep its submit button DISABLED for everything except `verified`,
 * and say which of the three it is. This is a reversal of an earlier decision
 * here, and the reason is worth recording: releasing the button on `unavailable`
 * looked kinder, but the server fails closed on a missing token, so every one
 * of those submissions was refused — with "We couldn't verify that you're
 * human", which reads as an accusation for something entirely outside the
 * person's control. A disabled button beside a clear explanation and a retry is
 * both more honest and less alarming than a live button that cannot work.
 *
 * `interactive` exists because the other three cannot express "your turn". With
 * `appearance: "always"` Cloudflare may decide a click is needed, and a form
 * that only knows "pending" tells the person the system is busy while the
 * system is in fact waiting for them — so they wait, then refresh, forever.
 */
export type TurnstileStatus = "pending" | "interactive" | "verified" | "unavailable";

/**
 * What a gated submit button should say, and whether it should show a spinner.
 *
 * Returns `null` once the check has passed, leaving the button to its own
 * label. Shared because signup, password reset and contact all render the same
 * four states and had drifted into three near-identical ternaries.
 *
 * A spinner ONLY for `pending`. Spinning at somebody while waiting for them to
 * click is the whole misunderstanding this state machine exists to fix.
 */
export function turnstileGate(status: TurnstileStatus): { label: string; busy: boolean } | null {
  switch (status) {
    case "verified":
      return null;
    case "unavailable":
      return { label: "Human check unavailable", busy: false };
    case "interactive":
      return { label: "Complete the check above to continue", busy: false };
    default:
      /*
        ASCII apostrophe on purpose. This string is the button's accessible
        name, and swapping in a typographic quote silently stops anything
        matching on it — which is how a passing test suite started failing on a
        purely visual change.
      */
      return { label: "Checking you're human…", busy: true };
  }
}

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
   * Forms use this to keep the submit button disabled until the check has
   * passed, and to say which state it is in. Without it, a fast typist submits
   * in under the two or three seconds the widget needs, sends an empty token,
   * and gets a confusing "we couldn't verify you're human" error for doing
   * nothing wrong.
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
    /**
     * This attempt has already been written off. Guards re-entry only.
     *
     * Note what it deliberately does NOT cover: a SUCCESSFUL attempt. The old
     * code latched one `settled` flag on both outcomes, so once a token had
     * arrived nothing could ever report a failure again — and a token that
     * later expired without being replaced had no path out of `pending`. A
     * check that worked and then stopped working is still a check that stopped
     * working, and has to be able to say so.
     */
    let abandoned = false;
    /**
     * Has Turnstile told us this challenge needs the person?
     *
     * Decides how `timeout-callback` is read: Cloudflare's documentation is
     * explicit that it means an interactive challenge went unanswered, so after
     * an interactive prompt it is "your turn, again" — not a fault.
     */
    let sawInteractive = false;
    /** Has this stretch of waiting already been given a fresh challenge? */
    let tokenRetried = false;
    let tokenTimer: ReturnType<typeof setTimeout> | undefined;

    const script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;

    /** Start (or restart) the clock on a rendered widget producing a token. */
    function armTokenTimer() {
      clearTimeout(tokenTimer);
      tokenTimer = setTimeout(tokenDeadlineExpired, TOKEN_TIMEOUT_MS);
    }

    /**
     * The widget is up and has produced nothing for a full budget.
     *
     * Escalated SEPARATELY from `attemptFailed`, and that separation is the
     * point. `attemptFailed` exists for a script that would not load, so it
     * throws the script away and refetches — which is worth eight seconds three
     * times over. Here the script demonstrably loaded and the widget
     * demonstrably drew itself, so refetching it is both irrelevant and
     * ruinously slow: three sixty-second rounds is three minutes of a person
     * staring at a disabled button, which is barely better than the forever it
     * replaced.
     *
     * So: ask Turnstile for one fresh challenge in place, and if that produces
     * nothing either, say so. Ninety seconds, then a verdict.
     */
    function tokenDeadlineExpired() {
      if (cancelled || abandoned) return;
      if (!tokenRetried && widgetId.current && window.turnstile) {
        tokenRetried = true;
        try {
          window.turnstile.reset(widgetId.current);
        } catch {
          // Best effort. The deadline below is the guarantee, not the reset.
        }
        tokenTimer = setTimeout(tokenDeadlineExpired, TOKEN_RETRY_TIMEOUT_MS);
        return;
      }
      abandoned = true;
      clearTimeout(widgetTimer);
      report("unavailable");
    }

    /** This attempt did not produce a usable check. Try again, or give up. */
    function attemptFailed() {
      if (cancelled || abandoned) return;
      abandoned = true;
      clearTimeout(widgetTimer);
      clearTimeout(tokenTimer);
      if (attempt + 1 < MAX_ATTEMPTS) {
        // Drop the script so the next attempt refetches rather than replaying
        // the browser's cached failure.
        document.getElementById(SCRIPT_ID)?.remove();
        /*
         * Re-gate the button before rebuilding.
         *
         * Tearing the widget down takes its hidden `cf-turnstile-response`
         * input — and whatever token was in it — with it. Without this, a check
         * that had already passed and then errored left the status on
         * `verified` while the field behind it was emptied: a live submit
         * button over no token at all, which the server refuses with "we
         * couldn't verify that you're human". That accusation for something
         * outside the person's control is the exact failure this component
         * exists to prevent, so it must not be reintroduced by the retry path.
         */
        report("pending");
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
         * The widget is up, so the WIDGET budget has done its job — and the
         * TOKEN budget takes over. Handing off between the two, rather than
         * simply stopping the clock, is the whole point: it keeps a slow widget
         * from being torn down while still guaranteeing that every path out of
         * here is bounded.
         */
        clearTimeout(widgetTimer);
        armTokenTimer();
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
            clearTimeout(tokenTimer);
            // A fresh stretch of waiting later — after an expiry, say — gets its
            // own full budget and its own one reset, rather than inheriting a
            // spent one and failing instantly.
            tokenRetried = false;
            report("verified");
          },
          "error-callback": () => attemptFailed(),
          /*
            A token is single-use and short-lived — about five minutes, which a
            careful person filling in a signup form will exceed. Going back to
            `pending` re-blocks the button, which is right: submitting an expired
            token fails exactly like submitting none.

            `refresh-expired` defaults to `auto`, so Turnstile normally mints a
            replacement on its own and `callback` brings us back to `verified`.
            The timer is re-armed for when it does not: that silent case is what
            turned an already-filled-in form into a permanently unsendable one,
            and it left `timeout-or-duplicate` rejections in the security log as
            its only trace.
          */
          "expired-callback": () => {
            report("pending");
            armTokenTimer();
          },
          /*
            Cloudflare is about to ask the person to do something. Our clock
            stops: from here the wait is theirs, and timing it out would declare
            a perfectly healthy widget dead for the sin of being patient.
          */
          "before-interactive-callback": () => {
            sawInteractive = true;
            clearTimeout(tokenTimer);
            report("interactive");
          },
          // They answered it; the wait is ours again.
          "after-interactive-callback": () => {
            report("pending");
            armTokenTimer();
          },
          /*
            NOT a failure, despite the name. Cloudflare documents this as an
            interactive challenge that went unanswered — "user action required".
            Treating it as a broken widget is how someone ended up reading that
            their ad-blocker was at fault, with a working challenge box sitting
            directly above the message and a retry link that could not help.

            So: hand them a fresh challenge and ask again. Only if we were never
            told this challenge was interactive does it fall back to the ordinary
            bounded wait.
          */
          "timeout-callback": () => {
            if (cancelled) return;
            try {
              if (widgetId.current) window.turnstile?.reset(widgetId.current);
            } catch {
              // Reset is best-effort; the deadline below is the real guarantee.
            }
            if (sawInteractive) {
              report("interactive");
              return;
            }
            report("pending");
            armTokenTimer();
          },
        });
      } catch {
        attemptFailed();
      }
    }

    /*
      Per-attempt budget for the script and the widget. Expiring it is not a
      verdict — it starts another attempt, and only the last one reports failure.
      A slow CDN should cost a few extra seconds, not the ability to sign up.

      Declared here, referenced by the functions above. Those are function
      declarations, so they are hoisted, and none can run before this line: the
      listeners that call them are attached below it.
    */
    const widgetTimer = setTimeout(attemptFailed, WIDGET_TIMEOUT_MS);

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
      // widget timer is what moves things along.
      script.addEventListener("load", render);
      script.addEventListener("error", attemptFailed);
    }

    return () => {
      cancelled = true;
      clearTimeout(widgetTimer);
      clearTimeout(tokenTimer);
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

      {status === "interactive" && (
        <p className="field-hint" style={{ marginTop: "0.5rem" }} aria-live="polite">
          Cloudflare needs one more thing from you — complete the check above and the button below
          will unlock.
        </p>
      )}

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

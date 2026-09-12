/**
 * Cookie notice.
 *
 * Inkloom sets no advertising or cross-site tracking cookies, so there is no
 * lawful-basis question to settle before the page loads and nothing to block
 * behind a wall. What there IS worth asking about is first-party product
 * analytics: it is not strictly necessary for the service to work, which under
 * the ePrivacy Directive and the DPDP Act is the line that matters.
 *
 * So this is a notice with a genuine choice, not a dark pattern:
 *
 *   - Both buttons are the same size and weight. "Reject" is not hidden
 *     behind "Manage preferences", and neither is styled to be the obvious
 *     one.
 *   - Nothing is set before the choice is made. Analytics stays off until
 *     accepted, rather than running and being switched off afterwards.
 *   - Dismissing without choosing does NOT count as consent. The banner
 *     returns next visit.
 *   - The decision is reversible from /cookies at any time.
 *
 * The choice itself lives in localStorage rather than a cookie, so recording
 * "no thanks" does not require setting the very thing that was declined.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";

const STORAGE_KEY = "inkloom.cookie-choice";

export type CookieChoice = "accepted" | "rejected";

/** What the visitor has already decided, if anything. */
export function readCookieChoice(): CookieChoice | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "accepted" || value === "rejected" ? value : null;
  } catch {
    // Private browsing, or storage disabled. Treat as undecided, which means
    // analytics stays off — the safe direction.
    return null;
  }
}

function writeCookieChoice(choice: CookieChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
    window.dispatchEvent(new CustomEvent("inkloom:cookie-choice", { detail: choice }));
  } catch {
    // If it cannot be stored, the banner simply asks again next time. That is
    // the correct failure: it never silently assumes consent.
  }
}

export function CookieNotice() {
  /*
   * Starts hidden and appears after mount, deliberately.
   *
   * The choice lives in localStorage, which the server cannot read, so a
   * server-rendered banner would flash for people who decided months ago.
   */
  const [choice, setChoice] = useState<CookieChoice | null | "unknown">("unknown");

  useEffect(() => {
    setChoice(readCookieChoice());
  }, []);

  /*
   * Make room for the banner instead of covering the page with it.
   *
   * It is fixed to the bottom, so without this it sits on top of whatever is
   * there — which on a long form is the submit button. The E2E suite caught it
   * as "subtree intercepts pointer events"; a person would have experienced it
   * as a button that does nothing when clicked.
   */
  useEffect(() => {
    if (choice !== null) return;
    const el = document.querySelector<HTMLElement>(".cookie-notice");
    if (!el) return;

    const apply = () => {
      document.body.style.paddingBottom = `${el.offsetHeight}px`;
    };
    apply();

    // The banner wraps at narrow widths, so its height is not a constant.
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.body.style.paddingBottom = "";
    };
  }, [choice]);

  if (choice !== null) return null;

  const decide = (next: CookieChoice) => {
    writeCookieChoice(next);
    setChoice(next);
  };

  return (
    <div className="cookie-notice" role="dialog" aria-labelledby="cookie-notice-title">
      <div className="cookie-notice-inner">
        <div>
          <p id="cookie-notice-title" style={{ fontWeight: 600 }}>
            Cookies on Inkloom
          </p>
          <p style={{ marginTop: "0.375rem", color: "var(--color-muted)" }}>
            We use a few cookies that are necessary for signing in and keeping the site secure —
            those cannot be turned off. Separately, we would like to measure how the site is used,
            with our own analytics. No advertising, and nothing shared with anyone else. See our{" "}
            <Link to="/cookies">cookie policy</Link>.
          </p>
        </div>
        <div className="cookie-notice-actions">
          {/* Same size, same weight. The choice is real or it is not a choice. */}
          <button type="button" className="btn btn-outline" onClick={() => decide("rejected")}>
            Necessary only
          </button>
          <button type="button" className="btn btn-ink" onClick={() => decide("accepted")}>
            Accept analytics
          </button>
        </div>
      </div>

      <style>{`
        .cookie-notice {
          position: fixed; inset-inline: 0; bottom: 0; z-index: 60;
          background: var(--color-panel);
          border-top: 1px solid var(--color-rule);
          box-shadow: 0 -8px 24px rgba(18, 17, 14, 0.06);
        }
        .cookie-notice-inner {
          max-width: 68rem; margin-inline: auto;
          padding: 1.125rem 1.5rem;
          display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap;
          font-size: var(--text-fine);
        }
        .cookie-notice-inner > div:first-child { flex: 1 1 22rem; }
        .cookie-notice-actions { display: flex; gap: 0.625rem; flex-wrap: wrap; }
        .cookie-notice-actions .btn { min-height: 2.5rem; padding-inline: 1rem; }
        @media (max-width: 40rem) {
          .cookie-notice-actions { width: 100%; }
          .cookie-notice-actions .btn { flex: 1; }
        }
      `}</style>
    </div>
  );
}

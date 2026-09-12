/**
 * First-party product analytics.
 *
 * Events go to Inkloom's own API and are stored in Inkloom's own database.
 * There is no third-party script, no advertising pixel, and nothing that
 * follows a visitor to another site. It is still not STRICTLY NECESSARY for
 * the service to work, which is the test that matters, so `track` sends
 * nothing until the visitor has actively accepted.
 *
 * WHAT IS NEVER SENT, enforced on both sides:
 *   - email addresses, names, or anything else identifying
 *   - access codes
 *   - passwords or any form field content
 *   - cookies or session values
 *
 * The client sends an allowlisted event name plus bounded, non-sensitive
 * properties; the server re-validates that allowlist with Zod, so a tampered
 * client cannot widen it. The user id is attached SERVER-side from the session,
 * never sent from the browser.
 */
import { readCookieChoice } from "../components/cookie-notice";

export const ANALYTICS_EVENTS = [
  "landing_viewed",
  "primary_cta_clicked",
  "examples_viewed",
  "signup_started",
  "signup_completed",
  "email_verified",
  "login_completed",
  "early_access_viewed",
  "access_code_attempted",
  "access_code_redeemed",
  "dashboard_viewed",
  "credits_viewed",
  "profile_completed",
  "support_submitted",
  "account_export_requested",
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

const ANON_KEY = "inkloom.anon";
const UTM_KEY = "inkloom.attribution";

/**
 * A random per-browser identifier.
 *
 * Kept in localStorage rather than a cookie: it is never sent automatically,
 * never reaches another site, and clearing site data removes it. It is not
 * derived from anything about the device, so it is not a fingerprint.
 */
function anonymousId(): string | undefined {
  try {
    let id = localStorage.getItem(ANON_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(ANON_KEY, id);
    }
    return id;
  } catch {
    // Private mode, or storage blocked. Events still send, just unattributed.
    return undefined;
  }
}

interface Attribution {
  source?: string;
  medium?: string;
  campaign?: string;
  referrer?: string;
  landingPath?: string;
}

/**
 * First-touch attribution.
 *
 * Captured once and never overwritten, so a visitor who arrives from a campaign
 * and returns directly a week later is still credited to that campaign.
 */
export function captureAttribution(): Attribution {
  try {
    const stored = localStorage.getItem(UTM_KEY);
    if (stored) return JSON.parse(stored) as Attribution;

    const params = new URLSearchParams(window.location.search);
    const attribution: Attribution = {
      source: params.get("utm_source") ?? undefined,
      medium: params.get("utm_medium") ?? undefined,
      campaign: params.get("utm_campaign") ?? undefined,
      // Only the referring ORIGIN, never the full URL — a referrer path can
      // carry someone else's private query string.
      referrer: safeOrigin(document.referrer),
      landingPath: window.location.pathname,
    };

    localStorage.setItem(UTM_KEY, JSON.stringify(attribution));
    return attribution;
  } catch {
    return {};
  }
}

function safeOrigin(url: string): string | undefined {
  if (!url) return undefined;
  try {
    const origin = new URL(url).origin;
    return origin === window.location.origin ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * Record an event.
 *
 * Fire-and-forget, and `keepalive` so an event fired during a navigation still
 * arrives. A failure is swallowed entirely: analytics must never break a page
 * or delay an interaction.
 */
export function track(
  name: AnalyticsEvent,
  properties?: Record<string, string | number | boolean>,
): void {
  if (typeof window === "undefined") return;

  /*
   * Consent first, and it is not assumed.
   *
   * Analytics is first-party and modest, but it is not strictly necessary for
   * the service to work — which is the line the ePrivacy Directive and the
   * DPDP Act draw. So nothing is recorded until someone has actively accepted,
   * and an undecided visitor counts as a no. A banner that asks and then sends
   * the event anyway is worse than no banner at all.
   */
  if (readCookieChoice() !== "accepted") return;

  const attribution = captureAttribution();

  const body = JSON.stringify({
    name,
    anonymousId: anonymousId(),
    path: window.location.pathname,
    utm: {
      source: attribution.source,
      medium: attribution.medium,
      campaign: attribution.campaign,
    },
    referrer: attribution.referrer,
    landingPath: attribution.landingPath,
    properties,
  });

  void fetch("/api/v1/analytics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    keepalive: true,
    body,
  }).catch(() => {
    // Deliberately silent.
  });
}

/** Clear the stored identifiers. Called on sign-out and on deletion. */
export function forgetAnalyticsIdentity(): void {
  try {
    localStorage.removeItem(ANON_KEY);
    localStorage.removeItem(UTM_KEY);
  } catch {
    // Nothing to do.
  }
}

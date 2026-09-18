/**
 * Security response headers.
 *
 * `X-XSS-Protection` is deliberately absent: it is deprecated, removed from
 * modern browsers, and its legacy filter introduced vulnerabilities of its own.
 * CSP is the control that actually works.
 */

export interface SecurityHeaderOptions {
  /** Per-response nonce for inline scripts. Generated fresh for every request. */
  nonce: string;
  isProduction: boolean;
  /**
   * Whether this deployment is served over HTTPS.
   *
   * Separate from `isProduction` on purpose. Three hardening measures used to
   * key off `isProduction` alone — HSTS, `strict-dynamic` and
   * `upgrade-insecure-requests` — which meant production was the FIRST place
   * any of them ever ran. Staging is supposed to be a rehearsal; a policy that
   * only exists in production is a policy nobody has tested.
   *
   * `strict-dynamic` is the sharp one: under it, host allowlists and `'self'`
   * in `script-src` are ignored entirely, and only nonced scripts (plus what
   * they load) execute. A single un-nonced bundle tag would have taken the
   * whole application down in production while staging looked perfect.
   */
  isSecureTransport: boolean;
  /** Extra connect-src entries, e.g. the Sentry ingest host. */
  connectSrc?: readonly string[];
  /** Turnstile is only loaded on pages that render the widget. */
}

/**
 * Content-Security-Policy.
 *
 * Notable choices:
 *  - No `unsafe-inline` for scripts. React Router streams a small inline
 *    hydration script, which carries the per-request nonce instead.
 *  - `'strict-dynamic'` in production so nonce-trusted scripts may load their
 *    own chunks without the URL allowlist becoming a bypass.
 *  - `style-src` does permit `'unsafe-inline'`: React inline styles and the
 *    theme bootstrap need it, and CSS injection is a far weaker primitive than
 *    script injection. Documented as a known limitation rather than hidden.
 *  - `frame-ancestors 'none'` — clickjacking defence, replacing X-Frame-Options.
 *  - `object-src 'none'`, `base-uri 'self'` — closes plugin and base-tag
 *    injection paths.
 */
/**
 * Cloudflare's bot-protection origin, allowed on EVERY document.
 *
 * It needs three directives, not one: `script-src` so the widget's script
 * loads, `frame-src` so its iframe renders, and `connect-src` because the
 * script calls back to Cloudflare over fetch to fetch and solve the challenge.
 * Missing the third produced the most misleading failure in this project — the
 * script loaded and reported success, then silently produced no widget, and the
 * form told the visitor their ad-blocker was at fault.
 *
 * UNCONDITIONAL, and that is the correction to a real mistake. These origins
 * used to be added only on the routes that render a form. But CSP is a property
 * of a DOCUMENT, not of a route, and this is a client-side-routed application:
 * clicking from the home page to /auth/signup fetches no new document, so the
 * page keeps running under the home page's CSP and Turnstile is blocked
 * outright. It worked on refresh — a real document load — which made it look
 * like flakiness rather than a header.
 *
 * Per-route CSP cannot work here. The cost of allowing it everywhere is that an
 * injected script could load Cloudflare's own bot-protection bundle, which is
 * not an escalation worth the broken signup form it was buying.
 */
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export function contentSecurityPolicy(options: SecurityHeaderOptions): string {
  const script = [
    "'self'",
    `'nonce-${options.nonce}'`,
    options.isSecureTransport ? "'strict-dynamic'" : "",
    TURNSTILE_ORIGIN,
  ].filter(Boolean);

  const connect = ["'self'", TURNSTILE_ORIGIN, ...(options.connectSrc ?? [])];
  const frame = [TURNSTILE_ORIGIN];

  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", script],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", connect],
    ["frame-src", frame],
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
  ];

  if (options.isSecureTransport) {
    directives.push(["upgrade-insecure-requests", []]);
  }

  return directives
    .map(([name, values]) => (values.length ? `${name} ${values.join(" ")}` : name))
    .join("; ");
}

export function securityHeaders(options: SecurityHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": contentSecurityPolicy(options),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": [
      "accelerometer=()",
      "autoplay=()",
      "camera=()",
      "display-capture=()",
      "encrypted-media=()",
      "fullscreen=(self)",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "midi=()",
      "payment=()",
      "usb=()",
      "xr-spatial-tracking=()",
      "interest-cohort=()",
    ].join(", "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Frame-Options": "DENY",
  };

  /*
   * HSTS on every HTTPS deployment, but only production commits to the strong
   * form.
   *
   * Staging gets a plain one-year max-age: enough to exercise the header and
   * catch a mixed-content or redirect problem, while staying reversible by
   * lowering max-age. `includeSubDomains; preload` is neither — preload in
   * particular is a public list that takes months to leave, and it would bind
   * every subdomain of the apex, so it stays a deliberate production-only
   * commitment.
   *
   * Never sent over plain HTTP, where it would poison localhost.
   */
  if (options.isProduction) {
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
  } else if (options.isSecureTransport) {
    headers["Strict-Transport-Security"] = "max-age=31536000";
  }

  return headers;
}

/** Headers for any response carrying account data. Never let a cache hold it. */
export const NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
};

/** Per-request CSP nonce. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");
}

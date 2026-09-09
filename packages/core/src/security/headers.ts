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
  /** Extra connect-src entries, e.g. the Sentry ingest host. */
  connectSrc?: readonly string[];
  /** Turnstile is only loaded on pages that render the widget. */
  allowTurnstile?: boolean;
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
export function contentSecurityPolicy(options: SecurityHeaderOptions): string {
  const script = [
    "'self'",
    `'nonce-${options.nonce}'`,
    options.isProduction ? "'strict-dynamic'" : "",
    options.allowTurnstile ? "https://challenges.cloudflare.com" : "",
  ].filter(Boolean);

  const connect = ["'self'", ...(options.connectSrc ?? [])];
  const frame = options.allowTurnstile ? ["https://challenges.cloudflare.com"] : ["'none'"];

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

  if (options.isProduction) {
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

  if (options.isProduction) {
    // Two years, subdomains included, preload-eligible. Only sent over HTTPS,
    // and never in development where it would poison localhost.
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
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

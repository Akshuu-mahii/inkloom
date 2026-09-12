/**
 * Open-redirect prevention.
 *
 * Auth flows carry a `next` parameter so a user lands where they intended after
 * signing in. Reflecting that value unchecked is a classic phishing primitive:
 * `/auth/login?next=https://evil.example` produces a link that genuinely starts
 * on inkloom.com and ends somewhere else.
 *
 * Only same-site, absolute PATHS are permitted — never absolute URLs, never
 * protocol-relative, never anything that could resolve off-origin.
 */

/** Paths a user should never be bounced back into after authenticating. */
const DENIED_PREFIXES = ["/auth/", "/api/"];

/** Control characters (incl. CR/LF/TAB) that could split a Location header. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function safeRedirectPath(candidate: string | null | undefined, fallback = "/app"): string {
  if (!candidate || typeof candidate !== "string") return fallback;

  const value = candidate.trim();
  if (value === "") return fallback;

  // Must be a rooted path. This rejects "https://evil.com", "//evil.com",
  // "javascript:alert(1)", "data:..." and bare "evil.com" in one test.
  if (!value.startsWith("/")) return fallback;

  // "//evil.com" and "/\evil.com" are protocol-relative URLs in browsers.
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;

  // Some browsers normalise backslashes to forward slashes, so a value
  // containing one cannot be reasoned about safely.
  if (value.includes("\\")) return fallback;

  // Newlines or control characters could split a response header.
  if (CONTROL_CHARS.test(value)) return fallback;

  /*
   * React Router fetches route data from the page path with `.data` appended,
   * so a session that expires during a client-side navigation produces a
   * redirect target like `/app/sessions.data`. Sending someone there after
   * sign-in lands them on raw JSON instead of the page they asked for.
   *
   * Handled here rather than only at the call sites, because this is the one
   * place every redirect target passes through — including a stale link
   * someone bookmarked while the bug existed.
   */
  const withoutDataSuffix = value.endsWith(".data") ? value.slice(0, -".data".length) : value;
  if (withoutDataSuffix !== value) {
    return safeRedirectPath(withoutDataSuffix || "/", fallback);
  }

  // Resolve against a sentinel origin and confirm nothing escaped it.
  let url: URL;
  try {
    url = new URL(value, "https://inkloom.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "https://inkloom.invalid") return fallback;

  const path = `${url.pathname}${url.search}${url.hash}`;
  if (DENIED_PREFIXES.some((prefix) => path.startsWith(prefix))) return fallback;

  return path;
}

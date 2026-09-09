/**
 * Origin validation and CSRF defence.
 *
 * Inkloom is same-origin by design: the React app and the API are served by one
 * Worker on one hostname, so a state-changing request should ALWAYS carry an
 * Origin (or at minimum a Referer) matching that host. There is no legitimate
 * cross-origin writer, so anything else is rejected.
 *
 * Layered, because no single check is sufficient:
 *   1. SameSite=Lax on the session cookie — the browser withholds it from
 *      cross-site POSTs at all.
 *   2. Origin/Referer must match the app origin exactly, on every unsafe method.
 *   3. Unsafe methods only: reads never mutate, so GET/HEAD carry no CSRF risk.
 *   4. JSON content-type required, which blocks the classic HTML-form CSRF
 *      vector (a form can only send urlencoded/multipart/plain).
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

export interface OriginCheckInput {
  method: string;
  origin: string | null;
  referer: string | null;
  /** The app's own origin, from validated config. */
  allowedOrigin: string;
  /** Extra origins, e.g. a staging preview host. Empty in production. */
  additionalOrigins?: readonly string[];
}

export type OriginVerdict =
  { ok: true } | { ok: false; reason: "missing_origin" | "origin_mismatch" };

export function checkOrigin(input: OriginCheckInput): OriginVerdict {
  if (isSafeMethod(input.method)) return { ok: true };

  const allowed = new Set([input.allowedOrigin, ...(input.additionalOrigins ?? [])]);

  // Prefer Origin; fall back to Referer, which some privacy tools still send
  // when Origin is stripped.
  const candidate = input.origin ?? originOf(input.referer);

  if (!candidate) return { ok: false, reason: "missing_origin" };
  if (!allowed.has(candidate)) return { ok: false, reason: "origin_mismatch" };
  return { ok: true };
}

function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Content types accepted on state-changing requests.
 *
 * Deliberately excludes `application/x-www-form-urlencoded`, `multipart/form-data`
 * and `text/plain` — the only three a cross-origin HTML form can produce
 * without a preflight. Requiring JSON means a hostile page cannot forge a write
 * even if the Origin check were somehow bypassed.
 */
export function isAcceptableContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const base = contentType.split(";")[0]?.trim().toLowerCase();
  return base === "application/json";
}

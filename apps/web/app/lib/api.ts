/**
 * Typed client for the Inkloom API.
 *
 * Two callers, one contract:
 *
 *   - Route loaders and actions run on the SERVER and must forward the
 *     incoming request's cookies, because the Worker's `fetch` does not carry
 *     them automatically.
 *   - Browser code calls the same origin with `credentials: "same-origin"`.
 *
 * Nothing here ever reads or writes a token. The session lives entirely in the
 * `__Host-inkloom_session` cookie, which is HttpOnly — JavaScript cannot see
 * it, and nothing is kept in localStorage.
 */

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiResult<T> {
  data: T | null;
  error: ApiError | null;
  requestId: string;
  status: number;
  /**
   * `Set-Cookie` headers the API returned.
   *
   * These MUST be forwarded onto the response a loader or action sends back,
   * or the browser never receives the session cookie. Server-side `fetch` does
   * not propagate them: the Worker is acting as a client here, not as a proxy.
   * `withCookies()` below does the forwarding.
   */
  setCookies: string[];
}

export class ApiRequestError extends Error {
  constructor(
    readonly error: ApiError,
    readonly status: number,
    readonly requestId: string,
  ) {
    super(error.message);
    this.name = "ApiRequestError";
  }
}

interface CallOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** The inbound Request, when calling from a loader or action. */
  request?: Request;
  /** Absolute base, required on the server where relative URLs have no meaning. */
  baseUrl?: string;
  signal?: AbortSignal;
}

export async function call<T>(path: string, options: CallOptions = {}): Promise<ApiResult<T>> {
  const { method = "GET", body, request, baseUrl, signal } = options;

  const headers = new Headers({ accept: "application/json" });
  if (body !== undefined) headers.set("content-type", "application/json");

  let url = `/api/v1${path}`;

  if (request) {
    // --- Server side -----------------------------------------------------
    const origin = new URL(request.url).origin;
    url = `${baseUrl ?? origin}/api/v1${path}`;

    // Forward the session cookie so the API sees the same principal the
    // browser would.
    const cookie = request.headers.get("cookie");
    if (cookie) headers.set("cookie", cookie);

    // The API enforces a strict same-origin check on writes; a server-side
    // call has no browser Origin header, so it supplies its own.
    headers.set("origin", origin);

    // Propagate the request id so a page render and its API calls share one
    // correlation id in the logs.
    const requestId = request.headers.get("x-request-id");
    if (requestId) headers.set("x-request-id", requestId);
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    // Same-origin only. There is no cross-origin API to talk to.
    credentials: "same-origin",
    signal,
  });

  const payload = (await response.json().catch(() => ({
    data: null,
    error: { code: "INTERNAL_ERROR", message: "The server sent an unreadable response." },
    requestId: "",
  }))) as { data: T | null; error: ApiError | null; requestId: string };

  return {
    data: payload.data,
    error: payload.error,
    requestId: payload.requestId,
    status: response.status,
    setCookies: response.headers.getSetCookie?.() ?? [],
  };
}

/**
 * Build response headers carrying the API's cookies.
 *
 * Every auth action must pass its result through this, otherwise sign-in
 * appears to succeed and the next request is anonymous.
 *
 * The cookie strings are forwarded VERBATIM rather than reconstructed: Better
 * Auth sets `__Host-inkloom_session` with a precise combination of Secure,
 * HttpOnly, SameSite and Path, and re-serialising them by hand risks dropping
 * an attribute the browser depends on.
 */
export function withCookies(
  result: Pick<ApiResult<unknown>, "setCookies">,
  headers: Headers = new Headers(),
): Headers {
  for (const cookie of result.setCookies) {
    headers.append("set-cookie", cookie);
  }
  return headers;
}

/** Call and throw on failure. For loaders where an error should hit the boundary. */
export async function callOrThrow<T>(path: string, options: CallOptions = {}): Promise<T> {
  const result = await call<T>(path, options);
  if (result.error || result.data === null) {
    throw new ApiRequestError(
      result.error ?? { code: "INTERNAL_ERROR", message: "Something went wrong." },
      result.status,
      result.requestId,
    );
  }
  return result.data;
}

/**
 * Turn an API error into per-field messages a form can render.
 *
 * The server returns `details` keyed by field name, so the same validation
 * result drives both the summary and the individual inputs — a user never has
 * to guess which field the message belongs to.
 */
export function fieldErrors(error: ApiError | null): Record<string, string> {
  if (!error?.details) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(error.details)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface Me {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  role: "user" | "support" | "operations" | "admin" | "super_admin";
  status: string;
  twoFactorEnabled: boolean;
  /** False for an account created through Google: there is no password to confirm. */
  hasPassword: boolean;
  /** e.g. ["credential"], ["google"], or both once a password is set. */
  providers: string[];
  createdAt: string | null;
  earlyAccess: { joined: boolean; joinedAt: string | null };
  profile: { displayName: string; company: string | null; timezone: string | null };
  credits: { balance: number };
  redemptions: number;
  notificationPreferences: {
    securityEmail: boolean;
    productUpdatesEmail: boolean;
    marketingEmail: boolean;
    creditsEmail: boolean;
  };
  platform: {
    generationEnabled: boolean;
    paymentsEnabled: boolean;
    redemptionEnabled: boolean;
  };
}

export interface LedgerEntry {
  id: string;
  amount: number;
  type: string;
  balanceAfter: number;
  reason: string;
  createdAt: string;
  campaignName: string | null;
}

export interface SessionSummary {
  id: string;
  device: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  current: boolean;
}

export interface Paged<T> {
  items: T[];
  page: { nextCursor: string | null; hasMore: boolean };
}

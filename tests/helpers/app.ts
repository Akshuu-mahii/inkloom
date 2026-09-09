/**
 * Boots a real API app against the test database, driven over `fetch`.
 *
 * No mocking of the database, the auth library or the HTTP layer: these tests
 * exercise the same Hono app, the same Better Auth instance and the same
 * Postgres transactions that production runs. The only substitution is the
 * email transport, which captures messages so a test can read the verification
 * link out of one.
 */
import { buildServices, createApiApp } from "@inkloom/api";
import { ConsoleTransport } from "@inkloom/email";
import { createLogger } from "@inkloom/core/logger";
import { connectTestDb, type TestDb } from "./db";

export interface TestApp {
  db: TestDb;
  mail: ConsoleTransport;
  services: ReturnType<typeof buildServices>;
  /** Issue a request against the app. Paths are relative to `/api`. */
  fetch(path: string, init?: RequestInit & { cookies?: string[] }): Promise<Response>;
  /**
   * Truncate every table AND drop the settings cache.
   *
   * Truncation is an out-of-band change that the SettingsService's 5-second
   * cache cannot observe, so without the invalidate a flag set by one test
   * would leak into the next one.
   */
  reset(): Promise<void>;
  /** Same, but parses the response envelope. */
  json<T = unknown>(
    path: string,
    init?: RequestInit & { cookies?: string[] },
  ): Promise<{
    status: number;
    data: T | null;
    error: { code: string; message: string } | null;
    requestId: string;
    cookies: string[];
    response: Response;
  }>;
  close(): Promise<void>;
}

export const TEST_ORIGIN = "http://localhost:5173";

export function createTestApp(overrides: Record<string, string> = {}): TestApp {
  const db = connectTestDb();
  const mail = new ConsoleTransport();

  const services = buildServices({
    db: db.db,
    transport: mail,
    // Silent: these suites assert on behaviour, not on log output.
    logger: createLogger({ level: "error", sink: () => {} }),
    env: {
      INKLOOM_ENV: "test",
      APP_URL: TEST_ORIGIN,
      BETTER_AUTH_URL: TEST_ORIGIN,
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-to-pass-validation",
      ACCESS_CODE_PEPPER: "test-access-code-pepper-32-chars-long",
      IP_HASH_PEPPER: "test-ip-hash-pepper-32-characters-ok",
      EMAIL_TRANSPORT: "console",
      // Turnstile off by default so most tests need no token; the tests that
      // assert Turnstile behaviour switch it on explicitly.
      TURNSTILE_ENABLED: "false",
      RATE_LIMIT_ENABLED: "true",
      LOG_LEVEL: "error",
      ...overrides,
    },
  });

  const app = createApiApp(services);

  async function doFetch(
    path: string,
    init: RequestInit & { cookies?: string[] } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);

    // Same-origin by default: a test that wants to prove the CSRF guard sets a
    // different Origin explicitly.
    if (!headers.has("origin")) headers.set("origin", TEST_ORIGIN);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (init.cookies?.length) {
      headers.set("cookie", init.cookies.map(stripCookieAttributes).join("; "));
    }

    return app.fetch(new Request(`${TEST_ORIGIN}/api${path}`, { ...init, headers }));
  }

  return {
    db,
    mail,
    services,
    fetch: doFetch,
    async reset() {
      await db.truncate();
      services.settings.invalidate();
      mail.clear();
    },
    async json(path, init) {
      const response = await doFetch(path, init);
      const cookies = response.headers.getSetCookie?.() ?? [];
      const parsed = (await response.json().catch(() => ({
        data: null,
        error: null,
        requestId: "",
      }))) as { data: unknown; error: { code: string; message: string } | null; requestId: string };

      return {
        status: response.status,
        data: parsed.data as never,
        error: parsed.error,
        requestId: parsed.requestId,
        cookies,
        response,
      };
    },
    async close() {
      await db.close();
    },
  };
}

/** `name=value; Path=/; HttpOnly` -> `name=value` */
export function stripCookieAttributes(setCookie: string): string {
  return setCookie.split(";")[0]!.trim();
}

/** Find one cookie by name among Set-Cookie headers. */
export function cookieValue(cookies: string[], name: string): string | null {
  for (const cookie of cookies) {
    const [pair] = cookie.split(";");
    const [key, ...rest] = (pair ?? "").split("=");
    if (key?.trim() === name) return rest.join("=");
  }
  return null;
}

/**
 * Pull the token out of a link inside a captured email.
 *
 * Verification and reset flows only ever transmit their token by email, so a
 * test that wants to complete one has to read it the way a user would.
 */
export function extractToken(html: string, param = "token"): string | null {
  // Verification links carry the token as a query parameter...
  const queryMatch = new RegExp(`[?&]${param}=([A-Za-z0-9._~%-]+)`).exec(html);
  if (queryMatch?.[1]) return decodeURIComponent(queryMatch[1]);

  // ...while Better Auth's reset link puts it in a PATH segment:
  //   /api/auth/reset-password/<token>?callbackURL=...
  const pathMatch = /\/(?:reset-password|verify-email)\/([A-Za-z0-9._~%-]+)/.exec(html);
  return pathMatch?.[1] ? decodeURIComponent(pathMatch[1]) : null;
}

/**
 * The Cloudflare Worker entry.
 *
 * ONE Worker serves both the React application and the API, on one origin.
 * That is the same-origin backend-for-frontend the brief asks for: the session
 * cookie is first-party, there is no CORS anywhere, and the `__Host-` cookie
 * prefix applies.
 *
 *   /api/*   ->  Hono  (@inkloom/api)
 *   /*       ->  React Router SSR
 *
 * CONNECTION LIFETIME
 * -------------------
 * The database client is created PER REQUEST and closed with `waitUntil`.
 *
 * An earlier version cached a `pg` Pool for the life of the isolate, which is
 * the obvious optimisation and is wrong here: a Worker may not carry a socket
 * from one request context into another, so the cached pool intermittently
 * handed out a dead connection and queries failed with "Query read timeout"
 * — rarely under load, reliably after an idle gap, which is the worst kind of
 * bug to ship.
 *
 * Hyperdrive is what makes per-request clients cheap: it keeps the real pool of
 * Postgres connections at Cloudflare's edge, so opening a client here is a
 * local handshake rather than a new round trip to Neon.
 */
import { createRequestHandler, RouterContextProvider } from "react-router";
import { buildServices, createApiApp } from "@inkloom/api";
import { createDb } from "@inkloom/db/client";
import { generateNonce, securityHeaders } from "@inkloom/core/security";
import { nonceContext, servicesContext } from "../app/lib/context";

interface WorkerEnv {
  /** Hyperdrive binding. Presents an ordinary Postgres connection string. */
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
  [key: string]: unknown;
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

/** Pages that render the Turnstile widget, and so need its script and frame. */
const TURNSTILE_PATHS = ["/auth/signup", "/auth/login", "/auth/forgot-password", "/contact"];
/** Authenticated areas, which no shared cache may hold. */
const PRIVATE_PATHS = ["/app", "/admin"];

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const connectionString = env.HYPERDRIVE?.connectionString ?? (env.DATABASE_URL as string);
    if (!connectionString) {
      throw new Error("No database connection: bind HYPERDRIVE or set DATABASE_URL.");
    }

    const isLocal =
      connectionString.includes("localhost") || connectionString.includes("127.0.0.1");

    const { db, pool } = createDb({
      connectionString,
      // One connection is enough: a Worker request is single-threaded and the
      // real pooling happens in Hyperdrive.
      max: 1,
      ssl: !isLocal,
    });

    /**
     * Close the connection AFTER the handler has finished.
     *
     * `ctx.waitUntil` extends the isolate's lifetime; it does NOT defer the
     * promise it is given. Passing `pool.end()` directly therefore ended the
     * pool immediately, before a single loader had run, and every request
     * failed with "Cannot use a pool after calling end on the pool".
     *
     * Scheduling the close only once the response exists is what makes it
     * correct: by then every loader, action and API handler has completed.
     */
    const closeLater = () => ctx.waitUntil(pool.end().catch(() => {}));

    const services = buildServices({ db, env: env as Record<string, unknown> });
    const url = new URL(request.url);

    // --- API ---------------------------------------------------------------
    // Returns JSON, sets its own headers, and must not receive the document CSP.
    if (url.pathname.startsWith("/api/")) {
      const apiResponse = await createApiApp(services).fetch(request, env, ctx);
      closeLater();
      return apiResponse;
    }

    // --- Documents ---------------------------------------------------------
    // A fresh nonce per response, so the CSP can forbid inline script wholesale
    // while React Router's own hydration script still runs.
    const nonce = generateNonce();

    const context = new RouterContextProvider();
    context.set(servicesContext, services);
    context.set(nonceContext, nonce);

    const response = await requestHandler(request, context);
    /**
     * Safe here even though SSR streams: React Router resolves every loader
     * before rendering begins, and no route defers data with `Await`, so all
     * database work is complete by the time this resolves.
     */
    closeLater();

    const headers = securityHeaders({
      nonce,
      isProduction: services.config.isProduction,
      connectSrc: services.config.SENTRY_DSN ? [originOf(services.config.SENTRY_DSN)] : [],
      allowTurnstile: TURNSTILE_PATHS.some((path) => url.pathname.startsWith(path)),
    });

    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value);
    }

    if (PRIVATE_PATHS.some((path) => url.pathname.startsWith(path))) {
      response.headers.set("Cache-Control", "no-store, must-revalidate, private");
    }

    return response;
  },
} satisfies ExportedHandler<WorkerEnv>;

function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

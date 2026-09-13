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
import { runRetentionSweep } from "@inkloom/core/retention";
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
/**
 * Authenticated areas, which no shared cache may hold.
 *
 * The admin console's real prefix is a deployment secret, so it is added from
 * config at request time rather than listed here — a hardcoded "/admin" would
 * have silently stopped matching the moment a secret path was configured, and
 * the console would have started coming back cacheable.
 */
const PRIVATE_PATHS = ["/app", "/admin"];

/*
 * WHY THE MARKETING PAGES ARE NOT EDGE-CACHED
 * -------------------------------------------
 * They look like the obvious candidate: an anonymous request to `/` issues zero
 * database queries, so holding it at the edge would take the Worker out of the
 * path for exactly the traffic most likely to spike.
 *
 * It would also be a data leak. `routes/marketing/layout.tsx` has a loader that
 * resolves the session and server-renders the visitor's display name into the
 * header, so these pages are NOT identical for every visitor. A shared cache
 * would store one person's name and serve it to everyone who followed.
 *
 * `Vary: Cookie` is the textbook answer and does not help here: Cloudflare only
 * honours custom cache keys on Enterprise, and varying on the whole cookie
 * header would fragment the cache to a near-zero hit rate anyway.
 *
 * Two designs actually work, and both are a product decision rather than a
 * config change:
 *   1. Move the signed-in header state out of the loader and fetch it on the
 *      client after hydration. The document becomes genuinely public and fully
 *      cacheable; the header flickers from signed-out to signed-in.
 *   2. Cache only responses to requests carrying no session cookie, and bypass
 *      the cache entirely when one is present. Needs a Worker-side Cache API
 *      implementation, and signed-in visitors get no edge acceleration.
 *
 * Until one of those is chosen, no `public` caching goes on these routes.
 */

/** Open a per-request database client. See the connection-lifetime note above. */
function connect(env: WorkerEnv) {
  const connectionString = env.HYPERDRIVE?.connectionString ?? (env.DATABASE_URL as string);
  if (!connectionString) {
    throw new Error("No database connection: bind HYPERDRIVE or set DATABASE_URL.");
  }

  const isLocal = connectionString.includes("localhost") || connectionString.includes("127.0.0.1");

  return createDb({
    connectionString,
    // One connection is enough: a Worker request is single-threaded and the
    // real pooling happens in Hyperdrive.
    max: 1,
    ssl: !isLocal,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const { db, pool } = connect(env);

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

    /*
     * --- The decoy ---------------------------------------------------------
     *
     * The console is mounted at `ADMIN_PATH` by the route table itself (see
     * app/routes.ts), so the router generates correct links and nothing needs
     * rewriting here. What this does is make the obvious path a dead end: once
     * a secret path is configured, /admin answers exactly as any other missing
     * URL does, with no header, no redirect and no timing tell to distinguish
     * "moved" from "never existed".
     *
     * Obscurity only. Every request that reaches the real path still faces the
     * whole server-side gate — session, role, owner, 2FA, rate limit, audit —
     * and that gate would hold if this path were printed on the home page.
     */
    const adminPath = services.config.ADMIN_PATH;
    if (
      adminPath !== "/admin" &&
      (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))
    ) {
      closeLater();
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
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

    if ([...PRIVATE_PATHS, adminPath].some((path) => url.pathname.startsWith(path))) {
      response.headers.set("Cache-Control", "no-store, must-revalidate, private");
    } else {
      /*
       * Every other document renders the visitor's signed-in state (see the note
       * above the route lists), so none of them may enter a shared cache. Said
       * explicitly rather than left to a default, because the default is what a
       * CDN in front of this would guess.
       */
      response.headers.set("Cache-Control", "private, no-cache");
    }

    return response;
  },

  /**
   * Cron entry point.
   *
   * Everything the privacy policy promises to delete is deleted here, and
   * nowhere else. Before this existed the periods published at /privacy were
   * enforced by nothing at all: `purgeExpired` was written and never called,
   * and a data export whose payload the policy said was gone after 24 hours was
   * still sitting in the table.
   *
   * The connection is closed in a `finally`, not via `waitUntil`: a scheduled
   * invocation has no response to hang the lifetime off, so the handler must
   * own it from open to close or the pool leaks on every failure.
   */
  async scheduled(event: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
    const { db, pool } = connect(env);
    const services = buildServices({ db, env: env as Record<string, unknown> });
    const logger = services.logger.child({ cron: event.cron });

    try {
      const result = await runRetentionSweep(db, logger);

      /*
       * A partial failure is reported, not swallowed and not thrown.
       *
       * Throwing would mark the whole invocation failed and lose the steps that
       * did succeed; staying silent would let a step fail every night unnoticed.
       * Sentry gets told, the next run retries it, and nothing is lost either
       * way because every step is idempotent.
       */
      if (result.failed > 0) {
        const failures = result.steps.filter((s) => !s.ok);
        logger.error("retention_sweep_partial", {
          failed: result.failed,
          steps: failures.map((s) => `${s.name}: ${s.error}`),
        });
        services.monitoring.captureMessage(`Retention sweep: ${result.failed} step(s) failed`, {
          extra: { steps: failures.map((s) => ({ step: s.name, error: s.error })) },
        });
      }
    } catch (error) {
      logger.error("retention_sweep_failed", { error });
      services.monitoring.captureException(error, { extra: { cron: event.cron } });
      throw error;
    } finally {
      ctx.waitUntil(pool.end().catch(() => {}));
    }
  },
} satisfies ExportedHandler<WorkerEnv>;

function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

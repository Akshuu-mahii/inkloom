/**
 * The Inkloom API.
 *
 * One Hono app mounted at `/api` inside the same Worker that serves the React
 * application. That is the whole point of the same-origin BFF: the session
 * cookie is first-party, there is no CORS preflight anywhere, and no
 * cross-origin token exchange to get wrong.
 */
import { Hono } from "hono";
import type { Database } from "@inkloom/db/client";
import { loadConfig, type AppConfig } from "@inkloom/core/config";
import { createLogger, type Logger } from "@inkloom/core/logger";
import { createAuth } from "@inkloom/core/auth";
import { CreditService } from "@inkloom/core/credits";
import { RedemptionService } from "@inkloom/core/access-codes";
import { AuditService } from "@inkloom/core/audit";
import { RateLimiter } from "@inkloom/core/rate-limit";
import { SettingsService } from "@inkloom/core/settings";
import { TurnstileVerifier } from "@inkloom/core/security";
import { Mailer } from "@inkloom/core/notifications";
import { createMonitoring, sentryTransport } from "@inkloom/core";
import {
  ConsoleTransport,
  DevelopmentMailRouter,
  MailpitTransport,
  ResendTransport,
  type EmailTransport,
} from "@inkloom/email";
import type { Env, Services } from "./context";
import { errorResponse } from "./lib/response";
import {
  accessLog,
  bodyLimit,
  errorBoundary,
  noStore,
  originGuard,
  requestContext,
} from "./middleware/core";
import { loadPrincipal } from "./middleware/auth";
import { writeRateLimit } from "./middleware/rate-limit";
import { authRoutes } from "./routes/auth";
import { meRoutes } from "./routes/me";
import { codeRoutes, creditRoutes } from "./routes/credits";
import { analyticsRoutes, healthRoutes, supportRoutes } from "./routes/public";
import { adminRoutes } from "./routes/admin";
import { apiError } from "./lib/response";
import { buildOpenApiDocument } from "./openapi";

export * from "./context";
export * from "./lib/response";
export * as schemas from "./schemas/index";

/** Build the transport the configuration asks for. */
export function createTransport(config: AppConfig): EmailTransport {
  switch (config.EMAIL_TRANSPORT) {
    case "resend": {
      const resend = new ResendTransport(config.RESEND_API_KEY ?? "");
      // In development, keep RFC-reserved test addresses local so the E2E
      // suite neither fails on rejected recipients nor spends the daily send
      // quota. Real addresses still go to the real provider. Staging and
      // production route everything to Resend, with no local fallback to
      // silently swallow a message.
      if (config.INKLOOM_ENV !== "development") return resend;
      return new DevelopmentMailRouter(
        resend,
        new MailpitTransport(`http://${config.MAILPIT_HOST}:8025`),
      );
    }
    case "mailpit":
      // Mailpit's HTTP API, not SMTP — Workers cannot open an SMTP socket, and
      // using HTTP locally keeps dev on the same code path as production.
      return new MailpitTransport(`http://${config.MAILPIT_HOST}:8025`);
    case "console":
    default:
      return new ConsoleTransport();
  }
}

export interface BuildServicesOptions {
  db: Database;
  env: Record<string, unknown>;
  logger?: Logger;
  transport?: EmailTransport;
}

/**
 * Construct the services for one request.
 *
 * Called from the Worker's `fetch`, and it has to be: it takes the per-request
 * database handle, and a Worker may not carry a socket between request
 * contexts. An earlier comment here claimed "once per isolate", which was the
 * intent and never the behaviour — worth stating plainly, because the gap
 * between the two was quietly costing a database round trip per request.
 *
 * What IS shared across requests in an isolate is everything that does not
 * depend on `db`: the parsed configuration, memoised below, and the settings
 * cache, which now lives at module scope in SettingsService.
 *
 * Config validation still happens on the first call, so a Worker with a bad or
 * placeholder secret fails before it serves traffic.
 */
const configCache = new WeakMap<object, AppConfig>();

function cachedConfig(env: Record<string, unknown>): AppConfig {
  /*
   * Keyed on the env object itself, which Workers hand back by identity for the
   * life of an isolate. A WeakMap rather than a module variable so tests that
   * build services with different environments do not see one another's config,
   * and so nothing is retained once an env object is gone.
   */
  const hit = configCache.get(env);
  if (hit) return hit;
  const parsed = loadConfig(configSource(env));
  configCache.set(env, parsed);
  return parsed;
}

/**
 * The environment as the config schema expects to see it.
 *
 * Deployed, the database credentials arrive as a HYPERDRIVE *binding object*
 * carrying a `connectionString`, and there is no DATABASE_URL anywhere in the
 * Worker environment. Locally there is, because `.dev.vars` sets one — which is
 * exactly why this was invisible until the first real deploy: every test and
 * every `wrangler dev` session supplied the variable that production does not
 * have, and the Worker threw `DATABASE_URL: expected string, received
 * undefined` on its very first request.
 *
 * Deriving it here rather than in the Worker keeps the WeakMap above keyed on
 * the original `env` object, whose identity Workers preserve for the life of an
 * isolate. Spreading into a fresh object at the call site would key the cache on
 * a new object per request and silently re-parse the config every time.
 */
export function configSource(env: Record<string, unknown>): Record<string, unknown> {
  if (typeof env.DATABASE_URL === "string" && env.DATABASE_URL !== "") return env;

  const hyperdrive = env.HYPERDRIVE as { connectionString?: string } | undefined;
  if (!hyperdrive?.connectionString) return env;

  return { ...env, DATABASE_URL: hyperdrive.connectionString };
}

export function buildServices(options: BuildServicesOptions): Services {
  const config = cachedConfig(options.env);

  const logger =
    options.logger ??
    createLogger({
      level: config.LOG_LEVEL,
      context: { env: config.INKLOOM_ENV, release: config.INKLOOM_RELEASE },
    });

  const transport = options.transport ?? createTransport(config);

  /*
   * Resend's shared sender only reaches the account owner.
   *
   * Until a domain is verified, Resend refuses every recipient except the
   * address that owns the account, with a 403. It is the first thing that goes
   * wrong on a freshly wired-up machine and it is invisible from the outside:
   * signup succeeds, the page says the mail is on its way, and nothing arrives.
   * Saying so once at boot is far cheaper than diagnosing it later.
   */
  if (config.EMAIL_TRANSPORT === "resend" && config.EMAIL_FROM.includes("resend.dev")) {
    logger.warn("email_sender_is_resend_shared_domain", {
      from: config.EMAIL_FROM,
      consequence:
        "Resend will refuse every recipient except the address that owns the API key. " +
        "Verify a domain at resend.com/domains and set EMAIL_FROM to it to reach anyone else.",
    });
  }

  const mailer = new Mailer(options.db, transport, logger, {
    from: config.EMAIL_FROM,
    replyTo: config.EMAIL_REPLY_TO,
  });

  const audit = new AuditService(options.db, logger);
  const credits = new CreditService(options.db, logger);
  const settings = new SettingsService(options.db, logger);
  const limiter = new RateLimiter(options.db, logger, {
    enabled: config.RATE_LIMIT_ENABLED,
    // Reads the `rate_limit_overrides` system setting, so an operator can widen
    // or tighten a bucket from /admin/settings without a deploy.
    getOverrides: () => settings.get("rate_limit_overrides"),
  });
  const redemption = new RedemptionService(
    options.db,
    credits,
    audit,
    logger,
    config.ACCESS_CODE_PEPPER,
  );
  const turnstile = new TurnstileVerifier({
    secretKey: config.TURNSTILE_SECRET_KEY,
    enabled: config.TURNSTILE_ENABLED,
    logger,
  });

  const monitoring = createMonitoring({
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT ?? config.INKLOOM_ENV,
    release: config.INKLOOM_RELEASE,
    logger,
    transport: config.SENTRY_DSN ? sentryTransport(config.SENTRY_DSN) : undefined,
  });

  const auth = createAuth({ db: options.db, config, logger, mailer });

  return {
    db: options.db,
    config,
    logger,
    auth,
    credits,
    redemption,
    audit,
    limiter,
    settings,
    turnstile,
    mailer,
    monitoring,
  };
}

/**
 * Build the API app.
 *
 * Middleware order is deliberate and load-bearing:
 *
 *   errorBoundary   outermost, so nothing escapes as a stack trace
 *   requestContext  assigns the request id every later layer logs with
 *   accessLog       one structured line per request
 *   bodyLimit       reject oversized payloads before parsing
 *   originGuard     CSRF/origin, BEFORE any session is looked at
 *   loadPrincipal   resolve the session from the database
 *   noStore         no account data in any cache
 */
export function createApiApp(services: Services) {
  /**
   * Base path `/api`, so this app is self-contained: it owns its full public
   * paths rather than depending on where a host happens to mount it. The Worker
   * simply forwards anything under `/api/` here, and Better Auth's own
   * `basePath` (`/api/auth`) lines up with the `/auth/*` route below.
   */
  const app = new Hono<Env>().basePath("/api");

  app.use("*", errorBoundary);
  app.use("*", requestContext(services));
  app.use("*", accessLog);
  app.use("*", bodyLimit);
  app.use("*", originGuard);
  app.use("*", loadPrincipal);
  app.use("*", noStore);

  // Health probes live outside /v1: they are infrastructure, not product API,
  // and their contract must never change with an API version.
  app.route("/", healthRoutes);

  /**
   * Better Auth's own routes.
   *
   * Mounted so the client SDK, the OAuth callback and the 2FA endpoints work,
   * while the hand-written `/api/v1/auth/*` routes above add Inkloom's policy
   * (Turnstile, cooldowns, enumeration protection, consent capture).
   */
  app.all("/auth/*", (c) => services.auth.handler(c.req.raw));

  const v1 = new Hono<Env>();

  /*
   * Aggregate write ceiling for an authenticated session.
   *
   * Mounted here rather than per-route so a new endpoint is covered the day it
   * is added, instead of the day someone remembers to annotate it. Reads and
   * unauthenticated requests pass straight through.
   */
  v1.use("*", writeRateLimit);

  /**
   * The machine-readable API description, generated from the same Zod schemas
   * the server validates against — so it cannot describe a shape the API would
   * reject. Public: it documents behaviour, never secrets.
   */
  v1.get("/openapi.json", (c) => c.json(buildOpenApiDocument(services.config.origin)));

  v1.route("/auth", authRoutes);
  v1.route("/me", meRoutes);
  v1.route("/credits", creditRoutes);
  v1.route("/access-codes", codeRoutes);
  v1.route("/support", supportRoutes);
  v1.route("/analytics", analyticsRoutes);
  v1.route("/admin", adminRoutes);

  app.route("/v1", v1);

  app.notFound((c) => errorResponse(c, apiError("NOT_FOUND")));

  app.onError((error, c) => {
    c.get("logger")?.error("unhandled_route_error", { error });
    return errorResponse(c, error);
  });

  return app;
}

export type ApiApp = ReturnType<typeof createApiApp>;

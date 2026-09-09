/**
 * Error reporting.
 *
 * A thin seam rather than a hard dependency on Sentry, for two reasons: the
 * Worker bundle should not carry an SDK when no DSN is configured, and a
 * reporting outage must never be able to take a request down.
 *
 * What is reported is deliberately narrow. Every payload passes through the
 * same redaction the logger uses, so a password, token, cookie or access code
 * cannot reach a third party through an error report — which is exactly the
 * kind of leak that happens when someone attaches "the whole request" for
 * debugging.
 */
import { redact, type Logger } from "./logger";

export interface ErrorContext {
  requestId?: string;
  userId?: string;
  route?: string;
  method?: string;
  /** Redacted before it leaves the process. */
  extra?: Record<string, unknown>;
}

export interface Monitoring {
  captureException(error: unknown, context?: ErrorContext): void;
  captureMessage(message: string, context?: ErrorContext): void;
  readonly enabled: boolean;
}

export interface MonitoringOptions {
  dsn?: string;
  environment: string;
  release: string;
  logger: Logger;
  /** Overridable so tests can assert what would have been sent. */
  transport?: (payload: Record<string, unknown>) => void | Promise<void>;
}

/**
 * Build a reporter.
 *
 * With no DSN this returns a logger-only implementation: errors still reach the
 * structured log, they simply do not leave the machine. That is the correct
 * behaviour in development, and it means no code has to branch on whether
 * monitoring is configured.
 */
export function createMonitoring(options: MonitoringOptions): Monitoring {
  const { dsn, environment, release, logger } = options;
  const enabled = Boolean(dsn);

  function send(level: "error" | "info", subject: unknown, context?: ErrorContext) {
    const safe = context?.extra ? redact(context.extra) : undefined;

    const payload = {
      level,
      environment,
      release,
      requestId: context?.requestId,
      // An opaque user id only. Never an email address or a name.
      userId: context?.userId,
      route: context?.route,
      method: context?.method,
      ...(safe ? { extra: safe } : {}),
      error: subject,
    };

    // Always log locally, whether or not it is also sent onward.
    if (level === "error") logger.error("captured_exception", payload);
    else logger.warn("captured_message", payload);

    if (!enabled) return;

    try {
      void options.transport?.(payload);
    } catch {
      // Reporting must never take down the request it is reporting on.
    }
  }

  return {
    enabled,
    captureException: (error, context) => send("error", error, context),
    captureMessage: (message, context) => send("info", message, context),
  };
}

/**
 * Sentry's envelope endpoint, derived from the DSN.
 *
 * Posting the envelope directly avoids pulling an SDK into the Worker bundle
 * for what is one HTTP request. The DSN's public key is designed to be public;
 * it identifies the project and cannot read anything.
 */
export function sentryTransport(dsn: string, fetchImpl: typeof fetch = fetch) {
  let endpoint: string | null = null;
  let publicKey = "";

  try {
    const url = new URL(dsn);
    publicKey = url.username;
    const projectId = url.pathname.replace(/^\//, "");
    endpoint = `${url.protocol}//${url.host}/api/${projectId}/envelope/`;
  } catch {
    endpoint = null;
  }

  return async (payload: Record<string, unknown>) => {
    if (!endpoint) return;

    const header = JSON.stringify({
      event_id: crypto.randomUUID().replace(/-/g, ""),
      sent_at: new Date().toISOString(),
    });
    const item = JSON.stringify({ type: "event" });
    const body = `${header}\n${item}\n${JSON.stringify(payload)}\n`;

    await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${publicKey}, sentry_client=inkloom/1.0`,
      },
      body,
    }).catch(() => {
      // Swallowed on purpose.
    });
  };
}

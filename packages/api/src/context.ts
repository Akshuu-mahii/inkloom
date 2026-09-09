/**
 * The request context.
 *
 * Services are constructed once per isolate and injected, rather than imported
 * as module singletons. That keeps every route testable against a throwaway
 * database and a capturing mail transport, with no global state to reset
 * between tests.
 */
import type { Database } from "@inkloom/db/client";
import type { AppConfig } from "@inkloom/core/config";
import type { Logger } from "@inkloom/core/logger";
import type { Auth } from "@inkloom/core/auth";
import type { CreditService } from "@inkloom/core/credits";
import type { RedemptionService } from "@inkloom/core/access-codes";
import type { AuditService } from "@inkloom/core/audit";
import type { RateLimiter } from "@inkloom/core/rate-limit";
import type { SettingsService } from "@inkloom/core/settings";
import type { TurnstileVerifier } from "@inkloom/core/security";
import type { Role } from "@inkloom/core/rbac";
import type { Mailer, Monitoring } from "@inkloom/core";

export interface Services {
  db: Database;
  config: AppConfig;
  logger: Logger;
  auth: Auth;
  credits: CreditService;
  redemption: RedemptionService;
  audit: AuditService;
  limiter: RateLimiter;
  settings: SettingsService;
  turnstile: TurnstileVerifier;
  mailer: Mailer;
  monitoring: Monitoring;
}

/** The authenticated principal, resolved server-side on every request. */
export interface Principal {
  userId: string;
  email: string;
  normalizedEmail: string;
  name: string;
  emailVerified: boolean;
  /** Read from the database — never from a header, body or cookie claim. */
  role: Role;
  status: string;
  twoFactorEnabled: boolean;
  sessionId: string;
  sessionCreatedAt: Date;
  /** Drives the "recent authentication" gate on sensitive actions. */
  lastAuthenticatedAt: Date;
}

export interface Variables {
  requestId: string;
  logger: Logger;
  services: Services;
  /** Present only after `requireAuth`. */
  principal?: Principal;
  /** Rotating keyed hash of the client IP. Raw IPs never enter the context. */
  ipHash: string | null;
  /** Raw client IP, held only for the duration of the request for Turnstile. */
  clientIp: string | null;
  startedAt: number;
}

export type Env = {
  Variables: Variables;
  Bindings: Record<string, unknown>;
};

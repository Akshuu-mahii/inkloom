/**
 * Cloudflare Turnstile verification.
 *
 * Verification happens on the SERVER against Cloudflare's siteverify endpoint.
 * A client-side widget alone proves nothing — the token must be redeemed
 * server-side, and each token is single-use, which is what stops replay.
 */
import type { Logger } from "../util/logger";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileResult {
  success: boolean;
  /** Cloudflare's machine codes, for logs only. Never shown to a user. */
  errorCodes: string[];
}

export interface TurnstileOptions {
  secretKey: string;
  enabled: boolean;
  logger: Logger;
  /** Overridable in tests so the suite never touches the network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class TurnstileVerifier {
  constructor(private readonly options: TurnstileOptions) {}

  /**
   * Verify a token.
   *
   * Behaviour when Cloudflare is unreachable is a deliberate choice: this
   * FAILS CLOSED, returning false. Turnstile guards signup and password reset,
   * and failing open would turn a Cloudflare outage into an open door for
   * automated account creation. The operator's lever for a genuine outage is
   * the `TURNSTILE_ENABLED` config flag, which is an explicit, audited decision
   * rather than a silent degradation.
   */
  async verify(
    token: string | undefined | null,
    remoteIp?: string | null,
  ): Promise<TurnstileResult> {
    if (!this.options.enabled) {
      return { success: true, errorCodes: [] };
    }
    if (!token || typeof token !== "string" || token.length > 4096) {
      return { success: false, errorCodes: ["missing-input-response"] };
    }
    if (!this.options.secretKey) {
      this.options.logger.error("turnstile_secret_missing");
      return { success: false, errorCodes: ["missing-input-secret"] };
    }

    const body = new FormData();
    body.append("secret", this.options.secretKey);
    body.append("response", token);
    // Cloudflare accepts the client IP as an extra signal. This is the one
    // place a raw IP is used, and it is sent to Cloudflare rather than stored.
    if (remoteIp) body.append("remoteip", remoteIp);

    const doFetch = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);

    try {
      const response = await doFetch(SITEVERIFY_URL, {
        method: "POST",
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        this.options.logger.warn("turnstile_http_error", { status: response.status });
        return { success: false, errorCodes: ["http-error"] };
      }

      const data = (await response.json()) as {
        success?: boolean;
        "error-codes"?: string[];
      };

      const success = data.success === true;
      const errorCodes = data["error-codes"] ?? [];

      if (!success) {
        this.options.logger.warn("turnstile_rejected", { errorCodes });
      }
      return { success, errorCodes };
    } catch (error) {
      // Fail closed. See the note above.
      this.options.logger.error("turnstile_unreachable", { error });
      return { success: false, errorCodes: ["internal-error"] };
    } finally {
      clearTimeout(timeout);
    }
  }
}

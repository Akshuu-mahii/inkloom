/**
 * Email transports.
 *
 * All three speak HTTP, deliberately: Cloudflare Workers cannot open an SMTP
 * connection, so a transport that only worked in Node would mean local
 * development exercised a different code path from production. Mailpit exposes
 * an HTTP send API alongside its SMTP listener, which lets local development
 * use the identical call shape as Resend.
 */
import type { EmailTransport, SendEmailInput, SendResult } from "./types";

/** Development: delivers into Mailpit's web UI at http://localhost:8025 */
export class MailpitTransport implements EmailTransport {
  readonly name = "mailpit";

  constructor(private readonly baseUrl: string) {}

  async send(input: SendEmailInput, from: string): Promise<SendResult> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          From: parseAddress(from),
          To: [{ Email: input.to }],
          Subject: input.subject,
          HTML: input.html,
          Text: input.text,
          /*
           * Was missing entirely, so every message sent locally arrived with no
           * Reply-To. It matters most for the support notification: without it,
           * replying to a complaint goes to the sending address rather than to
           * the person who wrote in.
           */
          ...(input.replyTo ? { ReplyTo: [{ Email: input.replyTo }] } : {}),
        }),
      });

      if (!response.ok) {
        return { ok: false, error: `Mailpit returned ${response.status}` };
      }
      const data = (await response.json()) as { ID?: string };
      return { ok: true, providerMessageId: data.ID };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "mailpit unreachable" };
    }
  }
}

/** Staging and production. */
export class ResendTransport implements EmailTransport {
  readonly name = "resend";

  constructor(private readonly apiKey: string) {}

  async send(input: SendEmailInput, from: string): Promise<SendResult> {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          // Never logged: the logger redacts any key named `authorization`.
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          // Resend deduplicates on this, so a retried send cannot double-deliver.
          ...(input.requestId ? { "Idempotency-Key": `${input.template}:${input.requestId}` } : {}),
        },
        body: JSON.stringify({
          from,
          to: [input.to],
          subject: input.subject,
          html: input.html,
          text: input.text,
          ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        id?: string;
        message?: string;
        name?: string;
      };

      if (!response.ok) {
        return { ok: false, error: data.message ?? `Resend returned ${response.status}` };
      }
      return { ok: true, providerMessageId: data.id };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "resend unreachable" };
    }
  }
}

/**
 * Tests and offline development. Records what WOULD have been sent, including
 * the URLs inside, so an integration test can assert a verification link was
 * generated without a mail server running.
 */
export class ConsoleTransport implements EmailTransport {
  readonly name = "console";
  readonly sent: Array<SendEmailInput & { from: string }> = [];

  async send(input: SendEmailInput, from: string): Promise<SendResult> {
    this.sent.push({ ...input, from });
    return { ok: true, providerMessageId: `console_${this.sent.length}` };
  }

  /** Most recent message sent to an address, for assertions. */
  lastTo(email: string): (SendEmailInput & { from: string }) | undefined {
    return [...this.sent].reverse().find((m) => m.to.toLowerCase() === email.toLowerCase());
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/**
 * Domains reserved by RFC 2606 and RFC 6761 for testing and documentation.
 *
 * These can never be registered, so no mailbox behind one can ever exist. Any
 * message addressed to one is undeliverable by definition — which is exactly
 * what makes them safe to keep local.
 */
const RESERVED_TLDS = ["test", "example", "invalid", "localhost"];
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];

/** True when no real mailbox can possibly exist at this address. */
export function isUndeliverableTestAddress(address: string): boolean {
  const domain = address.trim().toLowerCase().split("@").pop() ?? "";
  if (!domain) return true;
  return (
    RESERVED_TLDS.some((tld) => domain === tld || domain.endsWith(`.${tld}`)) ||
    RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))
  );
}

/**
 * Development-only routing between a real provider and the local catcher.
 *
 * Wanting real mail in a real inbox during development and wanting a test suite
 * are not in conflict, but a single flat transport makes them look that way.
 * Point everything at Resend and the E2E suite — which creates dozens of
 * `@example.test` accounts per run — gets every one of them rejected, and burns
 * the daily send quota trying. Point everything at Mailpit and no real message
 * ever arrives.
 *
 * So the recipient decides. An RFC-reserved address cannot belong to anyone, so
 * it goes to Mailpit; anything else is a real person and goes to the real
 * provider. There is no allowlist to maintain and no way for a fixture to
 * accidentally email a stranger.
 *
 * Development only. Staging and production always use the real transport
 * directly — see `createTransport`.
 */
export class DevelopmentMailRouter implements EmailTransport {
  readonly name: string;

  constructor(
    private readonly real: EmailTransport,
    private readonly local: EmailTransport,
  ) {
    this.name = `${real.name}+${local.name}`;
  }

  async send(input: SendEmailInput, from: string): Promise<SendResult> {
    if (isUndeliverableTestAddress(input.to)) {
      return this.local.send(input, from);
    }

    const result = await this.real.send(input, from);
    if (result.ok) return result;

    /*
     * The provider refused a real address. In development that is nearly always
     * a configuration answer rather than a dead address — Resend, for one,
     * refuses every recipient except the account owner until a domain is
     * verified, which is the single most likely thing to be wrong on a machine
     * that has just been wired up.
     *
     * Dropping the message there would leave a developer staring at an inbox
     * that never fills, so the message is also delivered locally and can be
     * read in Mailpit. The failure is NOT hidden: the real provider's own words
     * are returned as the error, and `Mailer` writes them to `email_events` and
     * logs them, so the send is still recorded as failed.
     */
    const fallback = await this.local.send(input, from);
    return {
      ok: false,
      providerMessageId: fallback.providerMessageId,
      error: fallback.ok
        ? `${result.error} — a copy was delivered to Mailpit so the flow can still be completed locally.`
        : result.error,
    };
  }
}

function parseAddress(value: string): { Email: string; Name?: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  if (match) return { Email: match[2]!.trim(), Name: match[1]!.replace(/^"|"$/g, "") };
  return { Email: value.trim() };
}

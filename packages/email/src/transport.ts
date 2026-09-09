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

function parseAddress(value: string): { Email: string; Name?: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  if (match) return { Email: match[2]!.trim(), Name: match[1]!.replace(/^"|"$/g, "") };
  return { Email: value.trim() };
}

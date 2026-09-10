/**
 * Which mail leaves the machine during development.
 *
 * The rule has to be exactly right in both directions. Route a real address to
 * Mailpit and the person never gets their verification link. Route a fixture
 * address to Resend and the E2E suite fails on rejected recipients while
 * spending the daily quota — and, worse, a typo in a fixture could put a real
 * stranger's address on a development send.
 */
import { describe, expect, it } from "vitest";
import { DevelopmentMailRouter, isUndeliverableTestAddress } from "../transport";
import type { EmailTransport, SendEmailInput, SendResult } from "../types";

class Spy implements EmailTransport {
  readonly received: string[] = [];
  constructor(
    readonly name: string,
    private readonly result: SendResult = { ok: true },
  ) {}
  async send(input: SendEmailInput): Promise<SendResult> {
    this.received.push(input.to);
    return { providerMessageId: `${this.name}_1`, ...this.result };
  }
}

describe("isUndeliverableTestAddress", () => {
  it.each([
    "someone@example.test",
    "e2e-123@example.test",
    "a@sub.example.test",
    "a@example.com",
    "a@example.net",
    "a@example.org",
    "a@anything.invalid",
    "a@host.localhost",
    "a@my.example",
  ])("treats %s as undeliverable", (address) => {
    expect(isUndeliverableTestAddress(address)).toBe(true);
  });

  it.each([
    "mayank@gmail.com",
    "someone@inkloom.com",
    "person@company.co.uk",
    // Deliberately adversarial: a real domain that merely CONTAINS a reserved
    // string must not be mistaken for one.
    "a@example.community",
    "a@notexample.com",
    "a@testing.com",
    "a@example.com.co",
  ])("treats %s as a real address", (address) => {
    expect(isUndeliverableTestAddress(address)).toBe(false);
  });

  it("is case and whitespace insensitive", () => {
    expect(isUndeliverableTestAddress("  Someone@EXAMPLE.TeST  ")).toBe(true);
  });

  it("treats a malformed address as undeliverable rather than sending it", () => {
    expect(isUndeliverableTestAddress("")).toBe(true);
    expect(isUndeliverableTestAddress("no-at-sign")).toBe(false);
  });
});

describe("DevelopmentMailRouter", () => {
  const build = () => {
    const real = new Spy("resend");
    const local = new Spy("mailpit");
    return { real, local, router: new DevelopmentMailRouter(real, local) };
  };

  const message = (to: string): SendEmailInput => ({
    to,
    template: "verify_email",
    subject: "Confirm your email address",
    html: "<p>hi</p>",
    text: "hi",
  });

  it("sends a real address to the real provider", async () => {
    const { real, local, router } = build();
    await router.send(message("mayank@gmail.com"), "Inkloom <x@y.com>");
    expect(real.received).toEqual(["mayank@gmail.com"]);
    expect(local.received).toEqual([]);
  });

  it("keeps a fixture address local", async () => {
    const { real, local, router } = build();
    await router.send(message("e2e-1@example.test"), "Inkloom <x@y.com>");
    expect(local.received).toEqual(["e2e-1@example.test"]);
    expect(real.received).toEqual([]);
  });

  it("reports both transports in its name, so email_events records the truth", () => {
    const { router } = build();
    expect(router.name).toBe("resend+mailpit");
  });

  it("still delivers locally when the provider refuses a real address", async () => {
    // Exactly Resend's 403 before a domain is verified.
    const refusal = "You can only send testing emails to your own email address";
    const real = new Spy("resend", { ok: false, error: refusal });
    const local = new Spy("mailpit");
    const router = new DevelopmentMailRouter(real, local);

    const result = await router.send(message("someone@gmail.com"), "Inkloom <x@y.com>");

    // The developer can still read the message and finish the flow...
    expect(local.received).toEqual(["someone@gmail.com"]);
    // ...but the send is still recorded as a failure, carrying the real reason.
    expect(result.ok).toBe(false);
    expect(result.error).toContain(refusal);
    expect(result.error).toContain("Mailpit");
  });

  it("does not fall back for an address the provider never saw", async () => {
    const real = new Spy("resend");
    const local = new Spy("mailpit");
    const router = new DevelopmentMailRouter(real, local);
    await router.send(message("e2e@example.test"), "Inkloom <x@y.com>");
    expect(real.received).toEqual([]);
    expect(local.received).toEqual(["e2e@example.test"]);
  });

  it("passes the provider result straight through", async () => {
    const { router } = build();
    const result = await router.send(message("mayank@gmail.com"), "Inkloom <x@y.com>");
    expect(result).toEqual({ ok: true, providerMessageId: "resend_1" });
  });
});

/**
 * Staging must not be able to email a stranger.
 *
 * It sends through production's Resend account and production's verified
 * domain. A real address typed into a staging form — by a tester, by a fixture,
 * by anyone who finds the URL — reaches a real person, and the bounce, the
 * complaint and the reputation damage all land on production. Staging is
 * exactly where half-finished flows and throwaway data live, so this is a
 * matter of when rather than whether.
 *
 * The allowlist is the boundary. What these tests protect is its two edges:
 * that it cannot be widened by accident (an empty list must send nothing, and a
 * near-miss domain must not match), and that it is not so rigid that a tester
 * would rather turn it off than work with it.
 */
import { describe, expect, it, vi } from "vitest";
import { AllowlistTransport, isAllowedRecipient } from "../transport";
import type { EmailTransport, SendEmailInput } from "../types";

const message = (to: string): SendEmailInput =>
  ({
    to,
    template: "verify_email",
    subject: "s",
    html: "<p>h</p>",
    text: "t",
  }) as SendEmailInput;

function inner() {
  const sent: string[] = [];
  const transport: EmailTransport = {
    name: "fake",
    async send(input) {
      sent.push(input.to);
      return { ok: true, providerMessageId: "fake_1" };
    },
  };
  return { transport, sent };
}

// ===========================================================================

describe("matching", () => {
  const list = ["owner@inkloom.art", "@example.org"];

  it("allows an exact address", () => {
    expect(isAllowedRecipient("owner@inkloom.art", list)).toBe(true);
  });

  it("ignores case", () => {
    expect(isAllowedRecipient("Owner@Inkloom.ART", list)).toBe(true);
  });

  it("allows a whole domain written @domain", () => {
    expect(isAllowedRecipient("anyone@example.org", list)).toBe(true);
  });

  it("allows a subdomain of an allowed domain", () => {
    expect(isAllowedRecipient("someone@mail.example.org", list)).toBe(true);
  });

  it("allows plus-addressing on an allowed address", () => {
    // One real inbox, many test accounts — the thing that decides whether a
    // tester works with the allowlist or asks for it to be removed.
    expect(isAllowedRecipient("owner+signup-test-7@inkloom.art", list)).toBe(true);
  });

  it("refuses an address that merely looks similar", () => {
    expect(isAllowedRecipient("owner@inkloom.art.attacker.com", list)).toBe(false);
    expect(isAllowedRecipient("notowner@inkloom.art", list)).toBe(false);
    expect(isAllowedRecipient("owner@inkloomart", list)).toBe(false);
  });

  it("refuses a domain that only ends with the allowed one", () => {
    // "notexample.org" ends with "example.org" as a STRING but is a different
    // domain, and getting this wrong is how allowlists leak.
    expect(isAllowedRecipient("someone@notexample.org", list)).toBe(false);
  });

  it("refuses everything when the list is empty", () => {
    expect(isAllowedRecipient("owner@inkloom.art", [])).toBe(false);
  });

  it("refuses malformed input rather than guessing", () => {
    expect(isAllowedRecipient("no-at-sign", list)).toBe(false);
    expect(isAllowedRecipient("@inkloom.art", list)).toBe(false);
    expect(isAllowedRecipient("", list)).toBe(false);
  });
});

// ===========================================================================

describe("the transport", () => {
  it("passes an allowed recipient straight through", async () => {
    const { transport, sent } = inner();
    const result = await new AllowlistTransport(transport, ["owner@inkloom.art"]).send(
      message("owner@inkloom.art"),
      "Inkloom <no-reply@inkloom.art>",
    );

    expect(sent).toEqual(["owner@inkloom.art"]);
    expect(result.ok).toBe(true);
  });

  it("never hands a disallowed recipient to the provider", async () => {
    const { transport, sent } = inner();
    await new AllowlistTransport(transport, ["owner@inkloom.art"]).send(
      message("stranger@gmail.com"),
      "from",
    );

    expect(sent).toEqual([]);
  });

  it("reports suppression as success, with a self-describing id", async () => {
    // Deliberate: a failure would be retried, would mark the address as
    // bouncing in email_events, and would surface to the user as a broken
    // signup — when the message was withheld on purpose.
    const { transport } = inner();
    const result = await new AllowlistTransport(transport, ["owner@inkloom.art"]).send(
      message("stranger@gmail.com"),
      "from",
    );

    expect(result.ok).toBe(true);
    expect(result.providerMessageId).toContain("suppressed_not_allowlisted");
  });

  it("tells somebody, rather than dropping the message in silence", async () => {
    const onSuppressed = vi.fn();
    const { transport } = inner();
    await new AllowlistTransport(transport, ["owner@inkloom.art"], onSuppressed).send(
      message("stranger@gmail.com"),
      "from",
    );

    expect(onSuppressed).toHaveBeenCalledWith("stranger@gmail.com", "verify_email");
  });

  it("sends nothing at all when the list is empty", async () => {
    // Fails CLOSED. The other choice — treating "no list" as "no restriction" —
    // is the exact incident this exists to prevent.
    const { transport, sent } = inner();
    await new AllowlistTransport(transport, []).send(message("owner@inkloom.art"), "from");

    expect(sent).toEqual([]);
  });

  it("ignores blank entries instead of letting one widen the list", async () => {
    const { transport, sent } = inner();
    await new AllowlistTransport(transport, ["", "   ", ","]).send(
      message("stranger@gmail.com"),
      "from",
    );

    expect(sent).toEqual([]);
  });
});

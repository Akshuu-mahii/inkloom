/**
 * Prove the mail configuration actually delivers.
 *
 *   pnpm email:test --to you@example.com
 *   pnpm email:test --to you@example.com --template welcome
 *
 * Mail failing silently is the worst shape this system has: the app records a
 * `failed` row in `email_events`, logs one line, and shows the person a page
 * saying the message is on its way. Nothing in the UI tells them otherwise.
 * This command closes that gap — it sends a real message through whichever
 * transport is configured and prints the provider's own answer, including the
 * exact rejection text when there is one.
 *
 * It renders a genuine template rather than a placeholder, so a template that
 * throws is caught here too.
 */
import {
  ConsoleTransport,
  MailpitTransport,
  ResendTransport,
  templates,
  type EmailTransport,
} from "@inkloom/email";
import { existsSync } from "node:fs";
import path from "node:path";
import { optional, repoRoot, required } from "./_env";

const TEMPLATES = {
  verify: (ctx: { appUrl: string; supportEmail: string }) =>
    templates.verifyEmail(ctx, {
      name: "Test Recipient",
      url: `${ctx.appUrl}/auth/verify-email?token=test-token-not-real`,
      expiresInMinutes: 1440,
    }),
  welcome: (ctx: { appUrl: string; supportEmail: string }) =>
    templates.welcome(ctx, { name: "Test Recipient", credits: 0 }),
  reset: (ctx: { appUrl: string; supportEmail: string }) =>
    templates.passwordReset(ctx, {
      name: "Test Recipient",
      url: `${ctx.appUrl}/auth/reset-password?token=test-token-not-real`,
      expiresInMinutes: 60,
    }),
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function buildTransport(kind: string): EmailTransport {
  switch (kind) {
    case "mailpit": {
      const host = optional("MAILPIT_HOST", "127.0.0.1");
      // 8025 is Mailpit's HTTP API. MAILPIT_PORT is its SMTP listener, which
      // Workers cannot speak to — see packages/email/src/transport.ts.
      return new MailpitTransport(optional("MAILPIT_URL", `http://${host}:8025`));
    }
    case "resend":
      return new ResendTransport(required("RESEND_API_KEY"));
    case "console":
      return new ConsoleTransport();
    default:
      console.error(
        `\n  Unknown EMAIL_TRANSPORT "${kind}". Expected mailpit, resend or console.\n`,
      );
      process.exit(1);
  }
}

async function main() {
  const to = arg("to");
  if (!to) {
    console.error(
      "\n  Usage: pnpm email:test --to you@example.com [--template verify|welcome|reset]\n",
    );
    process.exit(1);
  }

  const kind = optional("EMAIL_TRANSPORT", "console");
  const from = optional("EMAIL_FROM", "Inkloom <no-reply@mail.inkloom.com>");
  const appUrl = optional("APP_URL", "http://localhost:5173");
  const supportEmail = optional("SUPPORT_EMAIL", "support@inkloom.com");

  const templateName = (arg("template") ?? "verify") as keyof typeof TEMPLATES;
  const build = TEMPLATES[templateName];
  if (!build) {
    console.error(
      `\n  Unknown template "${templateName}". One of: ${Object.keys(TEMPLATES).join(", ")}\n`,
    );
    process.exit(1);
  }

  console.log("");
  console.log(`  transport   ${kind}`);
  console.log(`  from        ${from}`);
  console.log(`  to          ${to}`);
  console.log(`  template    ${templateName}`);
  console.log("");

  // The single most common way a first Resend send fails. Worth saying before
  // the attempt rather than leaving the operator to decode a 403.
  if (kind === "resend" && !from.includes("resend.dev")) {
    const domain = from.split("@").pop()?.replace(">", "").trim();
    console.log(`  Note: Resend will reject this unless "${domain}" is a verified sending`);
    console.log(`  domain on your account. Until you verify one, use:`);
    console.log(`      EMAIL_FROM="Inkloom <onboarding@resend.dev>"`);
    console.log(`  which can only deliver to the address that owns the Resend account.`);
    console.log("");
  }

  const transport = buildTransport(kind);
  const rendered = build({ appUrl, supportEmail });

  const started = Date.now();
  const result = await transport.send(
    {
      to,
      template: templateName,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      replyTo: optional("EMAIL_REPLY_TO", supportEmail),
    },
    from,
  );
  const elapsed = Date.now() - started;

  if (!result.ok) {
    console.error(`  FAILED after ${elapsed}ms`);
    console.error(`  ${result.error}`);
    console.error("");
    console.error("  Nothing was delivered. Fix the above and run this again before");
    console.error("  trusting signup, password reset or any other mail.");
    console.error("");
    process.exit(1);
  }

  console.log(`  Sent in ${elapsed}ms.`);
  if (result.providerMessageId) console.log(`  Provider message id: ${result.providerMessageId}`);
  console.log("");
  if (kind === "console") {
    console.log("  The console transport records messages in memory and sends nothing.");
  } else if (kind === "mailpit") {
    /*
     * Mailpit alone goes nowhere; Mailpit WITH a relay goes to a real inbox.
     * Saying the wrong one of those is how someone concludes mail is broken
     * when it worked, or waits for a message that was never going to arrive —
     * so the answer is read off the relay config rather than assumed.
     */
    const relaying = existsSync(path.join(repoRoot, ".mailpit", "relay.yaml"));
    console.log(
      relaying
        ? "  Relayed onward to a real inbox, and copied into http://localhost:8025.\n" +
            "  Reserved test domains are never relayed — see `pnpm mail:relay`."
        : "  Delivered to Mailpit only. Open http://localhost:8025 — it does NOT reach a real inbox.\n" +
            "  To reach real inboxes from local development, run `pnpm mail:relay`.",
    );
  } else {
    console.log("  Delivered to the provider. Check the real inbox, including spam.");
  }
  console.log("");
}

main().catch((error: unknown) => {
  console.error("\n  Unexpected failure:", error instanceof Error ? error.message : error, "\n");
  process.exit(1);
});

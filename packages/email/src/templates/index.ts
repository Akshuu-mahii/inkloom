/**
 * Transactional email templates.
 *
 * Every template returns both HTML and plain text, states link expiry where a
 * link is involved, and carries a support contact. None of them embeds a
 * secret beyond the single-use signed link the flow requires, and none is
 * tracked beyond the delivery status Resend reports.
 */
import { escapeHtml, renderLayout, renderText } from "../layout";
import type { RenderedEmail } from "../types";

export interface TemplateContext {
  appUrl: string;
  supportEmail: string;
}

interface Build {
  title: string;
  preview: string;
  /** Paragraphs. HTML-escaped by the caller where they interpolate user data. */
  paragraphs: string[];
  cta?: { label: string; url: string };
  footnote?: string;
}

function build(ctx: TemplateContext, spec: Build): RenderedEmail {
  return {
    subject: spec.title,
    html: renderLayout({
      title: spec.title,
      previewText: spec.preview,
      body: spec.paragraphs.map((p) => `<p style="margin:0 0 12px 0;">${p}</p>`).join(""),
      cta: spec.cta,
      footnote: spec.footnote,
      supportEmail: ctx.supportEmail,
      appUrl: ctx.appUrl,
    }),
    text: renderText({
      title: spec.title,
      lines: spec.paragraphs.map(stripTags),
      cta: spec.cta,
      footnote: spec.footnote,
      supportEmail: ctx.supportEmail,
    }),
  };
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** Friendly name, falling back to something neutral rather than "null". */
function greet(name?: string | null): string {
  const trimmed = name?.trim();
  return trimmed ? `Hi ${escapeHtml(trimmed)},` : "Hi,";
}

function humanDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

// ---------------------------------------------------------------------------
// 1. Verify email
// ---------------------------------------------------------------------------
export function verifyEmail(
  ctx: TemplateContext,
  data: { name?: string | null; url: string; expiresInMinutes: number },
): RenderedEmail {
  return build(ctx, {
    title: "Confirm your email address",
    preview: "One click and your Inkloom early-access account is ready.",
    paragraphs: [
      greet(data.name),
      "Confirm this address to finish setting up your Inkloom account and unlock your early-access credits.",
    ],
    cta: { label: "Confirm email address", url: data.url },
    footnote: `This link expires in ${humanDuration(data.expiresInMinutes)} and can only be used once. If you didn't create an Inkloom account, you can ignore this email — nothing will happen.`,
  });
}

// ---------------------------------------------------------------------------
// 2. Welcome
// ---------------------------------------------------------------------------
export function welcome(
  ctx: TemplateContext,
  data: { name?: string | null; credits: number },
): RenderedEmail {
  return build(ctx, {
    title: "Welcome to Inkloom early access",
    preview: "Your account is verified. Here's what happens next.",
    paragraphs: [
      greet(data.name),
      "Your email is confirmed and you're on the Inkloom early-access list.",
      data.credits > 0
        ? `You have <strong>${data.credits} promotional credits</strong> reserved on your account.`
        : "You can redeem an early-access code from your dashboard to reserve promotional credits.",
      "Inkloom's logo models aren't generating yet. We're building the typography systems, symbol libraries and composition engine first — you'll be among the first to know when generation opens, and your reserved credits will be waiting.",
    ],
    cta: { label: "Open your dashboard", url: `${ctx.appUrl}/app` },
  });
}

// ---------------------------------------------------------------------------
// 3. Password reset
// ---------------------------------------------------------------------------
export function passwordReset(
  ctx: TemplateContext,
  data: { name?: string | null; url: string; expiresInMinutes: number },
): RenderedEmail {
  return build(ctx, {
    title: "Reset your Inkloom password",
    preview: "A link to choose a new password.",
    paragraphs: [
      greet(data.name),
      "We received a request to reset the password on your Inkloom account. Choose a new one using the link below.",
    ],
    cta: { label: "Choose a new password", url: data.url },
    footnote: `This link expires in ${humanDuration(data.expiresInMinutes)} and can only be used once. If you didn't request this, you can safely ignore it — your password will not change, and any earlier reset links are now invalid.`,
  });
}

// ---------------------------------------------------------------------------
// 4. Password changed
// ---------------------------------------------------------------------------
export function passwordChanged(
  ctx: TemplateContext,
  data: { name?: string | null; when: string },
): RenderedEmail {
  return build(ctx, {
    title: "Your Inkloom password was changed",
    preview: "Confirming a change to your account security.",
    paragraphs: [
      greet(data.name),
      `The password on your Inkloom account was changed on ${escapeHtml(data.when)}.`,
      "All other signed-in devices have been signed out.",
      "<strong>If this wasn't you</strong>, reset your password immediately and contact us — someone may have access to your email.",
    ],
    cta: { label: "Review account security", url: `${ctx.appUrl}/app/security` },
  });
}

// ---------------------------------------------------------------------------
// 5. New or suspicious login
// ---------------------------------------------------------------------------
export function newLogin(
  ctx: TemplateContext,
  data: { name?: string | null; device: string; when: string; approximateLocation?: string },
): RenderedEmail {
  return build(ctx, {
    title: "New sign-in to your Inkloom account",
    preview: "A device we haven't seen before signed in.",
    paragraphs: [
      greet(data.name),
      "Your Inkloom account was signed in to from a device we haven't seen before.",
      `<strong>Device:</strong> ${escapeHtml(data.device)}<br><strong>When:</strong> ${escapeHtml(data.when)}${
        data.approximateLocation
          ? `<br><strong>Near:</strong> ${escapeHtml(data.approximateLocation)}`
          : ""
      }`,
      "If this was you, nothing to do. If not, sign out every device and change your password now.",
    ],
    cta: { label: "Review active sessions", url: `${ctx.appUrl}/app/sessions` },
  });
}

// ---------------------------------------------------------------------------
// 6. Early-access approval
// ---------------------------------------------------------------------------
export function earlyAccessApproved(
  ctx: TemplateContext,
  data: { name?: string | null; credits: number },
): RenderedEmail {
  return build(ctx, {
    title: "You're in: Inkloom early access",
    preview: "Your early-access place is confirmed.",
    paragraphs: [
      greet(data.name),
      "Your place in Inkloom early access is confirmed.",
      `<strong>${data.credits} promotional credits</strong> are reserved on your account, ready for when logo generation opens.`,
      "We'll email you the moment the first models go live.",
    ],
    cta: { label: "Open your dashboard", url: `${ctx.appUrl}/app` },
  });
}

// ---------------------------------------------------------------------------
// 7. Access code redeemed
// ---------------------------------------------------------------------------
export function codeRedeemed(
  ctx: TemplateContext,
  data: { name?: string | null; campaignName: string; credits: number; balance: number },
): RenderedEmail {
  return build(ctx, {
    title: "Access code redeemed",
    preview: `${data.credits} credits added to your account.`,
    paragraphs: [
      greet(data.name),
      `You redeemed <strong>${escapeHtml(data.campaignName)}</strong> and <strong>${data.credits} credits</strong> were added to your Inkloom account.`,
      `Your balance is now <strong>${data.balance} credits</strong>.`,
      "These are promotional early-access credits. They'll be usable as soon as logo generation opens.",
    ],
    cta: { label: "View your credits", url: `${ctx.appUrl}/app/credits` },
  });
}

// ---------------------------------------------------------------------------
// 8. Credits granted
// ---------------------------------------------------------------------------
export function creditsGranted(
  ctx: TemplateContext,
  data: { name?: string | null; credits: number; balance: number; reason: string },
): RenderedEmail {
  return build(ctx, {
    title: `${data.credits} credits added to your account`,
    preview: "Your Inkloom credit balance changed.",
    paragraphs: [
      greet(data.name),
      `<strong>${data.credits} credits</strong> were added to your Inkloom account.`,
      `Reason: ${escapeHtml(data.reason)}`,
      `Your balance is now <strong>${data.balance} credits</strong>.`,
    ],
    cta: { label: "View your credits", url: `${ctx.appUrl}/app/credits` },
  });
}

// ---------------------------------------------------------------------------
// 9. Account suspended
// ---------------------------------------------------------------------------
export function accountSuspended(
  ctx: TemplateContext,
  data: { name?: string | null; reason?: string | null },
): RenderedEmail {
  return build(ctx, {
    title: "Your Inkloom account has been suspended",
    preview: "Access to your account is paused.",
    paragraphs: [
      greet(data.name),
      "Your Inkloom account has been suspended and you've been signed out of all devices.",
      data.reason
        ? `Reason given: ${escapeHtml(data.reason)}`
        : "This usually follows activity that looked automated or abusive.",
      "Your credits and account data are preserved. If you think this is a mistake, reply to this email and a person will look at it.",
    ],
    cta: { label: "Contact support", url: `${ctx.appUrl}/contact` },
  });
}

// ---------------------------------------------------------------------------
// 10. Account restored
// ---------------------------------------------------------------------------
export function accountRestored(
  ctx: TemplateContext,
  data: { name?: string | null },
): RenderedEmail {
  return build(ctx, {
    title: "Your Inkloom account has been restored",
    preview: "You can sign in again.",
    paragraphs: [
      greet(data.name),
      "Your Inkloom account has been restored and you can sign in again. Your credits are untouched.",
      "Thanks for your patience.",
    ],
    cta: { label: "Sign in", url: `${ctx.appUrl}/auth/login` },
  });
}

// ---------------------------------------------------------------------------
// 11. Data export ready
// ---------------------------------------------------------------------------
export function dataExportReady(
  ctx: TemplateContext,
  data: { name?: string | null; expiresInHours: number },
): RenderedEmail {
  return build(ctx, {
    title: "Your Inkloom data export is ready",
    preview: "Download a copy of your account data.",
    paragraphs: [
      greet(data.name),
      "The copy of your Inkloom account data you asked for is ready to download from your profile.",
    ],
    cta: { label: "Download your data", url: `${ctx.appUrl}/app/profile` },
    footnote: `For your security the export is deleted after ${data.expiresInHours} hours. You can request a new one any time.`,
  });
}

// ---------------------------------------------------------------------------
// 12. Support request received
// ---------------------------------------------------------------------------
export function supportReceived(
  ctx: TemplateContext,
  data: { name?: string | null; reference: string; subject: string },
): RenderedEmail {
  return build(ctx, {
    title: `We got your message (${data.reference})`,
    preview: "Your support request has been logged.",
    paragraphs: [
      greet(data.name),
      `Thanks for writing in about "<strong>${escapeHtml(data.subject)}</strong>". Your reference is <strong>${escapeHtml(data.reference)}</strong>.`,
      "We read every message and usually reply within two working days. Quote your reference if you follow up.",
    ],
    cta: { label: "Check request status", url: `${ctx.appUrl}/app/support` },
  });
}

/**
 * The complaint itself, to whoever answers support.
 *
 * The acknowledgement above goes to the person who wrote in. This one is the
 * other half, and it was simply missing: a support form that only ever thanks
 * the sender and tells nobody is a form that loses every message.
 *
 * `replyTo` is set to the sender at the call site, so answering is one click
 * and the reply lands in their inbox rather than the support alias.
 */
export function supportSubmitted(
  ctx: TemplateContext,
  data: {
    reference: string;
    subject: string;
    category: string;
    message: string;
    fromName?: string | null;
    fromEmail: string;
    accountUrl?: string | null;
  },
): RenderedEmail {
  return build(ctx, {
    title: `Support: ${data.subject}`,
    preview: `${data.reference} — ${data.category}`,
    paragraphs: [
      `<strong>${escapeHtml(data.reference)}</strong> · ${escapeHtml(data.category)}`,
      `From ${escapeHtml(data.fromName ?? "someone")} &lt;${escapeHtml(data.fromEmail)}&gt;`,
      // The message verbatim, escaped, with line breaks kept so a paragraph
      // written as a paragraph still reads as one.
      escapeHtml(data.message).replace(/\n/g, "<br>"),
    ],
    cta: data.accountUrl ? { label: "Open in admin", url: data.accountUrl } : undefined,
  });
}

/**
 * A password added to an account that never had one.
 *
 * Distinct from `password_changed` on purpose. Someone who signed up with
 * Google and then set a password has not changed anything — telling them their
 * password "was changed" reads as a warning about something they did not do,
 * which is the opposite of reassuring.
 */
export function passwordAdded(
  ctx: TemplateContext,
  data: { name?: string | null; when: string },
): RenderedEmail {
  return build(ctx, {
    title: "A password was added to your account",
    preview: "You can now sign in with a password as well as with Google.",
    paragraphs: [
      greet(data.name),
      `A password was set on your Inkloom account for the first time on ${escapeHtml(data.when)}. You can now sign in either with Google or with your email address and this password.`,
      `If this was not you, change it immediately and tell us at <a href="mailto:${escapeHtml(ctx.supportEmail)}">${escapeHtml(ctx.supportEmail)}</a>.`,
    ],
    cta: { label: "Review your security settings", url: `${ctx.appUrl}/app/security` },
  });
}

export const TEMPLATE_IDS = [
  "verify_email",
  "welcome",
  "password_reset",
  "password_changed",
  "new_login",
  "early_access_approved",
  "code_redeemed",
  "credits_granted",
  "account_suspended",
  "account_restored",
  "data_export_ready",
  "support_received",
  "support_submitted",
  "password_added",
] as const;

export type TemplateId = (typeof TEMPLATE_IDS)[number];

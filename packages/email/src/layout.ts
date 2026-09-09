/**
 * Email layout.
 *
 * Hand-written table-based HTML rather than a component library: email clients
 * (Outlook especially) do not support modern CSS, everything must be inlined,
 * and the total surface here is small enough that a dependency would cost more
 * than it saves. Every template produces both HTML and plain text.
 *
 * Brand: Inkloom's cream ground, near-black type, and the orange accent from
 * the wordmark.
 */

export const BRAND = {
  cream: "#F7F4ED",
  ink: "#111111",
  inkSoft: "#5A564E",
  orange: "#F2622A",
  border: "#E3DED2",
  white: "#FFFFFF",
} as const;

export interface LayoutOptions {
  title: string;
  previewText: string;
  body: string;
  cta?: { label: string; url: string };
  /** Rendered under the CTA in small type, e.g. link expiry. */
  footnote?: string;
  supportEmail: string;
  appUrl: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export { escapeHtml };

export function renderLayout(options: LayoutOptions): string {
  const { title, previewText, body, cta, footnote, supportEmail, appUrl } = options;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.cream};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(previewText)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.cream};padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${BRAND.white};border:1px solid ${BRAND.border};border-radius:14px;">

<tr><td style="padding:28px 32px 8px 32px;">
<span style="font:700 22px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND.ink};letter-spacing:-0.02em;">inkl<span style="color:${BRAND.orange};">oo</span>m<span style="color:${BRAND.orange};">.</span></span>
</td></tr>

<tr><td style="padding:8px 32px 0 32px;">
<h1 style="margin:0 0 12px 0;font:600 20px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND.ink};">${escapeHtml(title)}</h1>
<div style="font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND.inkSoft};">${body}</div>
</td></tr>

${
  cta
    ? `<tr><td style="padding:24px 32px 4px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${BRAND.ink};border-radius:9px;">
<a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:13px 24px;font:600 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND.white};text-decoration:none;">${escapeHtml(cta.label)}</a>
</td></tr></table>
<p style="margin:14px 0 0 0;font:400 13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND.inkSoft};">
If the button doesn't work, copy this link into your browser:<br>
<span style="word-break:break-all;color:${BRAND.inkSoft};">${escapeHtml(cta.url)}</span>
</p>
</td></tr>`
    : ""
}

${
  footnote
    ? `<tr><td style="padding:16px 32px 0 32px;">
<p style="margin:0;font:400 13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND.inkSoft};">${escapeHtml(footnote)}</p>
</td></tr>`
    : ""
}

<tr><td style="padding:28px 32px 28px 32px;">
<hr style="border:none;border-top:1px solid ${BRAND.border};margin:0 0 16px 0;">
<p style="margin:0;font:400 13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND.inkSoft};">
Questions? Reply to this email or write to <a href="mailto:${escapeHtml(supportEmail)}" style="color:${BRAND.ink};">${escapeHtml(supportEmail)}</a>.
</p>
<p style="margin:10px 0 0 0;font:400 12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND.inkSoft};">
Inkloom &middot; <a href="${escapeHtml(appUrl)}" style="color:${BRAND.inkSoft};">${escapeHtml(appUrl.replace(/^https?:\/\//, ""))}</a><br>
This is a transactional message about your Inkloom account.
</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Compose the plain-text alternative. */
export function renderText(parts: {
  title: string;
  lines: string[];
  cta?: { label: string; url: string };
  footnote?: string;
  supportEmail: string;
}): string {
  const out = [parts.title, "=".repeat(parts.title.length), "", ...parts.lines];
  if (parts.cta) out.push("", `${parts.cta.label}:`, parts.cta.url);
  if (parts.footnote) out.push("", parts.footnote);
  out.push("", "---", `Questions? Write to ${parts.supportEmail}`, "Inkloom");
  return out.join("\n");
}

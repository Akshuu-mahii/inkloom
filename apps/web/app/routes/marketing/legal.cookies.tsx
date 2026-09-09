import type { Route } from "./+types/legal.cookies";
import { buildMeta } from "../../lib/seo";
import { LegalDocument, LEGAL_UPDATED } from "../../components/legal";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Cookie Policy",
    description: "Every cookie Inkloom sets, what it does, and how long it lasts.",
    path: location.pathname,
  });
}

export default function Cookies() {
  return (
    <LegalDocument
      title="Cookie Policy"
      updated={LEGAL_UPDATED}
      summary="Inkloom sets very few cookies, and none of them track you across other websites."
      sections={[
        {
          heading: "The whole list",
          paragraphs: [
            "__Host-inkloom_session — your sign-in session. Strictly necessary; without it you cannot stay signed in. HttpOnly, so JavaScript cannot read it, Secure, SameSite=Lax, and host-only. It lasts up to 30 days, or until you sign out.",
            "Cloudflare Turnstile cookies — set only on the signup, sign-in, password-reset and contact pages, by Cloudflare's bot check. Strictly necessary to tell a person from a script, and short-lived.",
            "That is the complete list. There is no advertising cookie, no third-party analytics cookie, and nothing that follows you to another site.",
          ],
        },
        {
          heading: "Why there is no cookie banner",
          paragraphs: [
            "Consent banners exist because sites set cookies that are not necessary — advertising, cross-site tracking, third-party analytics. Inkloom sets none of those, so there is nothing to ask you to consent to.",
            "Product analytics are first-party and do not use a cookie: an anonymous identifier is kept in your browser's local storage and is only linked to your account after you sign in and opt in. You can turn analytics off in your profile, and clearing site data removes the identifier.",
          ],
        },
        {
          heading: "Controlling them",
          paragraphs: [
            "Every browser lets you view and delete cookies for a site. Deleting Inkloom's will sign you out, and blocking them entirely will prevent you from signing in — the session cookie is how sign-in works.",
          ],
        },
        {
          heading: "Changes",
          paragraphs: [
            "If we ever add a cookie that is not strictly necessary, we will update this page and ask for your consent first.",
          ],
        },
      ]}
    />
  );
}

import type { Route } from "./+types/legal.cookies";
import { buildMeta } from "../../lib/seo";
import { LegalDocument, LEGAL_CONTACT, LEGAL_UPDATED } from "../../components/legal";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Cookie Policy",
    description: "Every cookie Inkloom sets, what it does, and how long it lasts.",
    path: location.pathname,
  });
}

/**
 * Cookie Policy.
 *
 * The previous version said there was nothing to consent to, which stopped
 * being true the moment product analytics existed: analytics is not strictly
 * necessary for the service to work, and that is the test. This names every
 * item, its purpose, its lifetime, and how to change the decision.
 */
export default function Cookies() {
  return (
    <LegalDocument
      title="Cookie Policy"
      updated={LEGAL_UPDATED}
      summary="Every cookie and equivalent technology Inkloom uses, what each is for, how long it lasts, and how to change your choice."
      contact="Questions about cookies?"
      sections={[
        {
          heading: "The short version",
          paragraphs: [
            "Inkloom uses a small number of strictly necessary cookies to sign you in and keep the service secure. Those cannot be switched off, because without them the service cannot work.",
            "Separately, we ask for your consent to first-party product analytics. That is a genuine choice: nothing is recorded until you accept, declining costs you nothing, and you can change your mind at any time.",
            "We use no advertising cookies, no third-party trackers, and nothing that follows you to another website.",
          ],
        },
        {
          heading: "Strictly necessary — always on",
          paragraphs: [
            "These are exempt from consent under the ePrivacy Directive and the equivalent rules elsewhere, because the service you asked for cannot be provided without them.",
          ],
          list: [
            "Session cookie (__Host-inkloom_session) — keeps you signed in. HttpOnly, so JavaScript cannot read it; SameSite=Lax; Secure in production. Expires after 7 days of inactivity and no later than 30 days.",
            "OAuth state (__Secure-inkloom.state, with a matching PKCE verifier) — protects a Google sign-in against interception while it is in progress. Deleted as soon as the sign-in completes, typically within a minute.",
            "Turnstile (set by challenges.cloudflare.com) — Cloudflare's bot check on the signup, sign-in, password-reset and contact forms. It distinguishes people from automated traffic and is not used for advertising or profiling.",
          ],
        },
        {
          heading: "Analytics — only with your consent",
          paragraphs: [
            "If you accept, we record which pages are viewed and which actions are taken, so we can tell what is confusing and what is working. It is first-party: the data goes to our own service and is never shared or sold.",
            "It is stored against a random identifier, not your name or email, and it is deleted after 14 months.",
            "If you decline, nothing is recorded at all. We do not collect first and delete later.",
          ],
          list: [
            "inkloom.cookie-choice (local storage) — remembers your answer so we stop asking. Set whichever way you answer, including when you decline, so that declining does not require setting a cookie you rejected.",
            "Analytics identifier (local storage, only if you accept) — a random value with no personal data in it, used to join one visit to the next.",
          ],
        },
        {
          heading: "Changing your mind",
          paragraphs: [
            "Clearing this site's data in your browser removes the stored choice, and we will ask again on your next visit.",
            "You can also block or delete cookies in your browser settings. Blocking the strictly necessary ones will prevent you from signing in — not as a penalty, but because the session cookie is what being signed in consists of.",
            `If you would rather we handled it for you, write to ${LEGAL_CONTACT} and we will.`,
          ],
        },
        {
          heading: "Do Not Track and Global Privacy Control",
          paragraphs: [
            "We do not run cross-site tracking, so there is nothing for a Do Not Track header to switch off. We treat a Global Privacy Control signal as a decision to decline analytics, and will not ask again while it is present.",
          ],
        },
        {
          heading: "Changes",
          paragraphs: [
            "If we add a cookie that is not strictly necessary, we will update this page and ask for your consent before setting it — not afterwards. The date at the top reflects the current version.",
          ],
        },
      ]}
    />
  );
}

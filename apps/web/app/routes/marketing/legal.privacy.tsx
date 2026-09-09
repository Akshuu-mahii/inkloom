import type { Route } from "./+types/legal.privacy";
import { buildMeta } from "../../lib/seo";
import { LegalDocument, LEGAL_UPDATED } from "../../components/legal";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Privacy Policy",
    description: "What data Inkloom holds about you, why, and what you can do about it.",
    path: location.pathname,
  });
}

export default function Privacy() {
  return (
    <LegalDocument
      title="Privacy Policy"
      updated={LEGAL_UPDATED}
      summary="What we hold, why we hold it, and how to get rid of it. Short, because we collect little."
      sections={[
        {
          heading: "What we collect",
          paragraphs: ["Only what the account actually needs:"],
          list: [
            "Your email address — to identify your account and send account emails.",
            "Your name — to address you.",
            "Your password, stored only as a scrypt hash. We never see the original.",
            "Optionally, a company name and time zone, if you provide them.",
            "Your credit history: grants, redemptions and adjustments.",
            "Session records: when you signed in, and a coarse device label such as “Chrome on macOS”.",
            "Consent records: what you agreed to and when.",
            "Support messages you send us.",
            "First-touch marketing attribution (utm_source and similar), if you arrived through a campaign link.",
          ],
        },
        {
          heading: "What we deliberately do not collect",
          list: [
            "Your IP address. For abuse monitoring we store a rotating keyed hash instead, which cannot be reversed to an address and changes daily.",
            "A device fingerprint, or your full user-agent string.",
            "Payment details. There is no checkout.",
            "Anything from third-party trackers. Product analytics are first-party and stay on our own servers.",
          ],
        },
        {
          heading: "Why we are allowed to hold it",
          list: [
            "To perform our contract with you: running your account, granting and tracking credits.",
            "Our legitimate interest in keeping the service secure: rate limiting, abuse detection and audit records.",
            "Your consent, for marketing email and product analytics — both optional, both withdrawable.",
            "Legal obligation, for the minimal accounting record of credit grants.",
          ],
        },
        {
          heading: "Who else sees it",
          paragraphs: ["A short list, and we do not sell anything to anyone:"],
          list: [
            "Neon — our database host.",
            "Cloudflare — hosting, and bot protection on our forms.",
            "Resend — sending account emails.",
            "Sentry — error reports, with personal data scrubbed.",
          ],
        },
        {
          heading: "How long we keep it",
          list: [
            "Account data: until you delete your account.",
            "Security and audit events: 24 months, then removed.",
            "Rate-limit counters: 48 hours.",
            "Data exports: deleted 24 hours after they are generated.",
            "Anonymised credit-accounting records: kept indefinitely, with nothing personal attached.",
          ],
        },
        {
          heading: "Your rights",
          paragraphs: [
            "You can export everything we hold from your profile, in one click, as JSON. You can correct your details there too, and you can delete your account outright.",
            "Deleting your account removes your email, name and profile, ends every session, and cancels pending email links. You may also ask us to restrict or object to processing, or complain to your data protection authority.",
          ],
        },
        {
          heading: "Where your data is",
          paragraphs: [
            "On servers in the European Union and the United States, operated by the providers listed above. Transfers rely on standard contractual clauses where required.",
          ],
        },
        {
          heading: "Children",
          paragraphs: [
            "Inkloom is not for children. We do not knowingly collect data from anyone under 16; if we learn that we have, we delete it.",
          ],
        },
        {
          heading: "Changes and contact",
          paragraphs: [
            "If we change this policy materially we will email account holders before it takes effect. For anything privacy-related, write to support@inkloom.com and a person will answer.",
          ],
        },
      ]}
      contact="Questions about your data?"
    />
  );
}

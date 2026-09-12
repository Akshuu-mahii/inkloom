import type { Route } from "./+types/legal.privacy";
import { buildMeta } from "../../lib/seo";
import { LegalDocument, LEGAL_CONTACT, LEGAL_ENTITY, LEGAL_UPDATED } from "../../components/legal";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Privacy Policy",
    description: "What personal data Inkloom collects, why, and what you can do about it.",
    path: location.pathname,
  });
}

/**
 * Privacy Policy.
 *
 * Organised around the questions a data-protection regime actually asks: who
 * the controller is, what categories of data, for what purpose, on what lawful
 * basis, who it is shared with, how long it is kept, where it goes, and what
 * rights you have and how to use them.
 *
 * The previous version described our storage topology, which tells a reader
 * nothing they can act on. What matters is the lawful basis, the retention
 * period, and the route to exercising a right — so those are what this says.
 */
export default function Privacy() {
  return (
    <LegalDocument
      title="Privacy Policy"
      updated={LEGAL_UPDATED}
      summary="What personal data we hold, the lawful basis for holding it, how long we keep it, and how to make us change or delete it."
      contact="Questions about your data, or want to exercise a right?"
      sections={[
        {
          heading: "Who is responsible for your data",
          paragraphs: [
            `${LEGAL_ENTITY} is the controller of the personal data described here. That means we decide what is collected and why, and we are accountable for it.`,
            `For any privacy question, or to exercise any right below, write to ${LEGAL_CONTACT}. We answer within 30 days, and sooner where we can. If you ask us to do something we cannot, we will tell you why rather than ignoring the request.`,
            "This policy covers the Inkloom website and the signed-in service. It does not cover other sites we link to.",
          ],
        },
        {
          heading: "What we collect, and why",
          paragraphs: ["We collect as little as the service can function on. Specifically:"],
          list: [
            "Account data — your email address, display name, and optionally a company name. Needed to create and identify your account.",
            "Authentication data — a hash of your password (never the password), two-factor secrets if you enable them, and session records. Needed to sign you in and keep the account secure.",
            "If you sign in with Google — your name, email address and profile picture, as supplied by Google. We request nothing else and cannot read your Google account.",
            "Account activity — credits granted, codes redeemed, and the resulting ledger. Needed to run the credit system and to keep accurate records.",
            "Support correspondence — what you write to us, so we can answer and follow up.",
            "Security and abuse signals — failed sign-in attempts, rate-limit counters, and a rotating keyed hash of your IP address. We do not store raw IP addresses.",
            "Product analytics, only if you accept — which pages are viewed and which actions are taken, under a random identifier that is not linked to your name.",
          ],
        },
        {
          heading: "The lawful basis for each purpose",
          paragraphs: [
            "Different data is held on different grounds, and the ground determines what rights you have over it:",
          ],
          list: [
            "Performance of a contract — account, authentication and credit data. Without these we cannot provide the service you asked for.",
            "Legitimate interests — security, fraud and abuse prevention, and keeping the service working. We have assessed that these do not override your rights, in part because the data is minimised and pseudonymised.",
            "Consent — product analytics and marketing email. Both are off unless you turn them on, and you can withdraw at any time without losing access to anything.",
            "Legal obligation — records we are required to keep, and responses to lawful requests.",
          ],
        },
        {
          heading: "What we do not do",
          list: [
            "We do not sell personal data. There is no arrangement under which anyone pays us for it.",
            "We do not use advertising networks, advertising pixels, or cross-site tracking.",
            "We do not share your data with third parties for their own marketing.",
            "We do not use customer content to train our models. If we ever want to, it will be a separate opt-in that is off by default.",
            "We do not make decisions producing legal or similarly significant effects about you by automated means alone.",
          ],
        },
        {
          heading: "Who else processes it",
          paragraphs: [
            "Running the service needs a small number of providers: hosting and content delivery, a managed database, an email delivery provider, and a bot-protection provider. Each acts only on our documented instructions, under a written processing agreement, and none may use your data for its own purposes.",
            "We will disclose data to a public authority only where we are legally required to. Where we are permitted to tell you, we will.",
            "If Inkloom is ever acquired or merged, your data may transfer as part of that business. You will be told before it happens, and this policy continues to apply until you are given notice of a replacement.",
          ],
        },
        {
          heading: "International transfers",
          paragraphs: [
            "Our providers operate globally, so your data may be processed outside the country you live in.",
            "Where data leaves a jurisdiction that restricts transfers, we rely on the mechanisms that law provides — an adequacy decision where one exists, and otherwise Standard Contractual Clauses with the provider, together with the technical measures described below. You may ask us for details of the mechanism relied on for a particular provider.",
          ],
        },
        {
          heading: "How long we keep it",
          paragraphs: ["Retention is by purpose, not indefinite by default:"],
          list: [
            "Account data — for as long as the account exists, then removed when it is deleted.",
            "Credit ledger entries — retained after deletion in anonymised form, with no personal data attached. They are accounting records and must remain accurate.",
            "Security events and abuse signals — 12 months, then deleted.",
            "Support correspondence — 24 months from the last message.",
            "Data exports — deleted 24 hours after they are generated.",
            "Analytics events — 14 months, and pseudonymous throughout.",
          ],
        },
        {
          heading: "Your rights",
          paragraphs: [
            "Depending on where you live you have some or all of the following rights, and we apply them to everyone regardless of where they live:",
          ],
          list: [
            "Access — a copy of what we hold. Available from your profile in one click, as JSON, without asking us.",
            "Rectification — correct anything inaccurate, from your profile.",
            "Erasure — have your account and personal data deleted. Write to us and we will do it.",
            "Restriction and objection — ask us to stop a particular processing, including anything based on legitimate interests.",
            "Portability — receive your data in a structured, machine-readable format. That is what the export gives you.",
            "Withdraw consent — turn off analytics or marketing at any time, with no effect on anything you have already been given.",
            "Complain — to your local data-protection authority. We would rather you came to us first, but it is your right either way.",
          ],
        },
        {
          heading: "How we protect it",
          paragraphs: [
            "Passwords are hashed with scrypt and are never recoverable, by us or anyone else. Sessions are held in cookies that JavaScript cannot read, and expire on both idle time and an absolute limit.",
            "Access to production data is limited to those who need it, every administrative action is recorded in an append-only audit trail, and staff accounts must use two-factor authentication.",
            "IP addresses are reduced to a rotating keyed hash before storage, so abuse can be detected without keeping a record of where you were.",
            "No system is perfectly secure. If a breach affects your personal data and is likely to result in a risk to your rights, we will notify the relevant authority within 72 hours and tell you directly where the risk is high.",
          ],
        },
        {
          heading: "Children",
          paragraphs: [
            "Inkloom is not intended for anyone under 16 and we do not knowingly collect their data. If you believe a child has given us personal data, tell us and we will delete it.",
          ],
        },
        {
          heading: "Changes to this policy",
          paragraphs: [
            "We will update this page when our practices change, and the date at the top always reflects the current version. For a change that materially affects your rights we will email the address on your account before it takes effect.",
          ],
        },
      ]}
    />
  );
}

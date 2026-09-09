import type { Route } from "./+types/legal.terms";
import { buildMeta } from "../../lib/seo";
import { LegalDocument, LEGAL_UPDATED } from "../../components/legal";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Terms of Service",
    description: "The terms that apply to your Inkloom account.",
    path: location.pathname,
  });
}

export default function Terms() {
  return (
    <LegalDocument
      title="Terms of Service"
      updated={LEGAL_UPDATED}
      summary="What you agree to by using Inkloom, and what we commit to in return. Written to be read."
      sections={[
        {
          heading: "What Inkloom is today",
          paragraphs: [
            "Inkloom is building AI models for logo design. Those models are not finished and are not available to users. Today, an Inkloom account lets you join early access, redeem promotional credits and manage your account — nothing more.",
            "We say this plainly because it matters: signing up does not give you the ability to generate a logo. If that is what you need right now, Inkloom cannot help you yet.",
          ],
        },
        {
          heading: "Your account",
          paragraphs: [
            "You must give a real email address and confirm it. You are responsible for keeping your password safe and for activity on your account. Tell us immediately if you think someone else has access.",
            "You must be old enough to enter a contract where you live. One person, one account.",
          ],
        },
        {
          heading: "Credits",
          paragraphs: [
            "Credits are the unit Inkloom will charge for generation work. They are not money, they have no cash value, and they cannot be transferred, sold or refunded for cash.",
            "Credits granted during early access are promotional and free. They do not expire. If we ever change that, we will tell you before it applies, and it will not apply retroactively to credits already in your account.",
            "We may remove credits obtained by abusing the access-code system — for example by redeeming a code you were not given, or by creating multiple accounts to redeem the same campaign. If we do, you will be told why.",
          ],
        },
        {
          heading: "Acceptable use",
          paragraphs: [
            "Our Acceptable Use Policy forms part of these terms. In short: do not attack the service, do not abuse other people through it, and do not try to obtain credits dishonestly.",
          ],
        },
        {
          heading: "Ownership of what you make",
          paragraphs: [
            "When generation opens, you will own full commercial rights to the marks generated on your account, with no attribution requirement. We will publish the precise wording before generation is enabled, and it will not be less favourable than this.",
            "You keep ownership of anything you provide to us. We do not use customer inputs to train our models unless you opt in, which is off by default.",
          ],
        },
        {
          heading: "What we do not promise",
          paragraphs: [
            "Inkloom is provided as it is. We do not promise it will be uninterrupted, error-free, or that a future feature will arrive on any particular date.",
            "We are not liable for indirect or consequential losses. Nothing in these terms limits liability for death, personal injury, or fraud — that would not be lawful, and we would not want to.",
          ],
        },
        {
          heading: "Suspension and closure",
          paragraphs: [
            "We may suspend an account that breaks these terms or the Acceptable Use Policy. Where we can, we will tell you why and give you a way to respond.",
            "You may close your account at any time from your profile. Closing it removes your personal data and forfeits any remaining credits. We keep an anonymised accounting record of credit grants because we are required to.",
          ],
        },
        {
          heading: "Changes",
          paragraphs: [
            "We may update these terms. For a material change we will email account holders before it takes effect. Continuing to use Inkloom after that means you accept the new version.",
          ],
        },
        {
          heading: "Law",
          paragraphs: [
            "These terms are governed by the laws of India, and the courts of Pune, Maharashtra have exclusive jurisdiction — except that you may also bring a claim in your own country of residence if the law there gives you that right.",
          ],
        },
      ]}
    />
  );
}

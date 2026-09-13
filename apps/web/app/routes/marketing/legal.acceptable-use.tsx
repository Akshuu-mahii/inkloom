import type { Route } from "./+types/legal.acceptable-use";
import { buildMeta } from "../../lib/seo";
import { LegalDocument, LEGAL_UPDATED } from "../../components/legal";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Acceptable Use Policy",
    description: "What you may not do with Inkloom, and what happens if you do.",
    path: location.pathname,
  });
}

export default function AcceptableUse() {
  return (
    <LegalDocument
      title="Acceptable Use Policy"
      updated={LEGAL_UPDATED}
      summary="The rules for using Inkloom. They are the obvious ones, written down so nobody has to guess."
      sections={[
        {
          heading: "Do not attack the service",
          list: [
            "No attempting to gain access to accounts, data or systems that are not yours.",
            "No probing, scanning or load-testing production. If you want to test something, tell us and we will help.",
            "No interfering with anyone else's use of Inkloom.",
            "No bypassing rate limits, bot checks or any other protection.",
          ],
        },
        {
          heading: "Do not abuse the credit system",
          list: [
            "No redeeming a code you were not given.",
            "No creating multiple accounts to redeem the same campaign more than once.",
            "No automated account creation.",
            "No selling, trading or transferring credits.",
          ],
        },
        {
          heading: "Do not use Inkloom to harm people",
          paragraphs: ["When generation opens, this will also mean not using it to create:"],
          list: [
            "Marks that impersonate a real organisation in order to deceive.",
            "Branding for fraud, scams or malware.",
            "Hateful imagery, or content that harasses or degrades a person or group.",
            "Anything that infringes someone else's trademark or copyright.",
          ],
        },
        {
          heading: "Reporting a security problem is not a breach",
          paragraphs: [
            "Good-faith security research is welcome and explicitly permitted. Stay within your own account, do not access anyone else's data, give us reasonable time before disclosing, and email security@inkloom.art. We will not pursue action against anyone who does that.",
          ],
        },
        {
          heading: "What happens if you break these rules",
          paragraphs: [
            "Depending on what happened, we may remove improperly obtained credits, suspend the account, or close it. Where we can, we will tell you what happened and give you a way to respond — an honest mistake and a deliberate attack are not the same thing, and we will not treat them the same way.",
            "Serious or illegal activity may be reported to the relevant authorities.",
          ],
        },
        {
          heading: "Reporting a violation",
          paragraphs: [
            "If you see something that breaks these rules, tell us through the contact form or at support@inkloom.art.",
          ],
        },
      ]}
    />
  );
}

import type { Route } from "./+types/legal.terms";
import { buildMeta } from "../../lib/seo";
import { LegalDocument, LEGAL_CONTACT, LEGAL_ENTITY, LEGAL_UPDATED } from "../../components/legal";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Terms of Service",
    description: "The agreement between you and Inkloom.",
    path: location.pathname,
  });
}

/**
 * Terms of Service.
 *
 * Structured the way a commercial agreement is actually structured — parties,
 * eligibility, licence and ownership, the things you may not do, money,
 * termination, the disclaimers and liability cap, and which courts decide a
 * dispute. Those last three are the clauses that matter if anything ever goes
 * wrong, and they were missing.
 *
 * Written to be read, not to be impenetrable, but without leaving out the parts
 * that carry weight.
 */
export default function Terms() {
  return (
    <LegalDocument
      title="Terms of Service"
      updated={LEGAL_UPDATED}
      summary="The agreement between you and Inkloom. Plain English, but these are the actual terms — including the limits on our liability and how disputes are resolved."
      contact="Questions about these terms?"
      sections={[
        {
          heading: "Who these terms are between",
          paragraphs: [
            `These terms form a binding agreement between you and ${LEGAL_ENTITY} ("Inkloom", "we", "us"). They apply every time you access the website, create an account, or use any part of the service.`,
            "If you do not agree to them, do not create an account. If you are agreeing on behalf of a company, you confirm you are authorised to bind that company, and “you” means that company.",
            "We may update these terms. For changes that materially reduce your rights we will give at least 30 days' notice by email to the address on your account, and the change will not apply retroactively. Continuing to use the service after a change takes effect means you accept it. If you do not, you may close your account.",
          ],
        },
        {
          heading: "What the service is today",
          paragraphs: [
            "Inkloom is building specialised AI models for logo design. Those models are not finished and are not available to users. Today an account lets you join early access, redeem promotional credits, and manage your profile and security settings. It does not let you generate a logo.",
            "We state this in the terms, not only in the marketing copy, because it defines what you are actually being offered. Nothing in these terms, on the website, or in any communication should be read as a promise that generation will launch by a particular date, or at all.",
            "Early access is a preview. Features may change, be withdrawn, or behave differently between releases, and the service may be unavailable at times without notice.",
          ],
        },
        {
          heading: "Eligibility and your account",
          paragraphs: [
            "You must be at least 16 years old and old enough to enter a binding contract where you live. The service is not directed at children, and we do not knowingly create accounts for them.",
            "You must give an email address you control and confirm it. You are responsible for everything done through your account, and for keeping your credentials secure. Tell us at once if you believe someone else has access.",
            "One person, one account. Creating multiple accounts to obtain credits more than once is a breach of these terms and of the Acceptable Use Policy.",
            "We may suspend or close an account that breaches these terms, that we reasonably believe is being used fraudulently, or where we are required to by law. Where we can, we will tell you why and give you a chance to respond.",
          ],
        },
        {
          heading: "Credits",
          paragraphs: [
            "Credits are an internal unit of account for work the service will perform. They are denominated in dollars for readability. They are not money, not a deposit, not e-money, and not a stored-value instrument. They carry no cash value, cannot be redeemed for cash, and cannot be sold, transferred or assigned.",
            "Credits granted during early access are promotional and were issued free of charge. They do not currently expire. If we introduce expiry we will give at least 30 days' notice, and it will not apply to credits already in your account at that time.",
            "We may reverse credits obtained in breach of these terms — for example by redeeming a code you were not issued, or by creating multiple accounts to redeem one campaign. Every adjustment is recorded with a reason, and you will be told.",
            "Because the service takes no payment today, no consumer right of withdrawal or refund arises in respect of credits. If and when paid plans launch, separate purchase terms will apply and will be presented before any payment is taken.",
          ],
        },
        {
          heading: "Your content and your rights in it",
          paragraphs: [
            "Anything you submit to the service remains yours. We claim no ownership of it.",
            "You grant us a limited, non-exclusive, worldwide, royalty-free licence to host, store, reproduce and transmit that content strictly to operate the service for you, and to comply with law. That licence exists only so the service can function, ends when you delete the content or close your account, and is not a licence to publish or commercialise your work.",
            "We will not use customer content to train our models unless you opt in. If we ever seek to, it will be a separate, clearly worded, opt-in choice that is off by default, and declining will not degrade the service.",
          ],
        },
        {
          heading: "Our rights",
          paragraphs: [
            "The service, the website, the Inkloom name and mark, the models, and everything we create remain ours or our licensors'. These terms grant you a personal, non-transferable, revocable right to use the service, and nothing more.",
            "You may not copy, modify, reverse-engineer, decompile, scrape, resell or create derivative works from the service, or use it to build a competing product, except where such a restriction is prohibited by law.",
          ],
        },
        {
          heading: "Acceptable use",
          paragraphs: [
            "The Acceptable Use Policy forms part of these terms and is binding. In short: do not attack or overload the service, do not use it to harm or deceive other people, do not attempt to obtain credits dishonestly, and do not use it for anything unlawful.",
            "We may remove content, restrict features, or suspend an account to stop an ongoing breach or to protect the service and the people using it.",
          ],
        },
        {
          heading: "Third parties we rely on",
          paragraphs: [
            "Operating the service requires providers for hosting, databases, email delivery and bot protection. They process data on our instructions under written terms, and we remain responsible to you for the service.",
            "The website may link to sites we do not control. We are not responsible for their content or their practices, and a link is not an endorsement.",
          ],
        },
        {
          heading: "Availability, and no warranty",
          paragraphs: [
            "The service is provided “as is” and “as available”. To the fullest extent permitted by law we exclude all implied warranties, including merchantability, fitness for a particular purpose, and non-infringement.",
            "We do not warrant that the service will be uninterrupted, timely, secure or error-free, that defects will be corrected, or that any output will meet your requirements. Early access is explicitly a preview and is not offered with a service-level commitment.",
            "Nothing in these terms excludes or limits liability that cannot lawfully be excluded — including for death or personal injury caused by negligence, for fraud or fraudulent misrepresentation, or for any rights you have as a consumer that cannot be waived.",
          ],
        },
        {
          heading: "Limitation of liability",
          paragraphs: [
            "Subject to the paragraph immediately above, we are not liable for indirect, incidental, special, consequential or punitive loss, nor for loss of profit, revenue, goodwill, business opportunity, or data, however caused and under any theory of liability.",
            "Our total aggregate liability arising out of or in connection with these terms or the service is limited to the greater of (a) the total amount you have paid us in the twelve months before the event giving rise to the claim, and (b) one hundred United States dollars. Because the service currently takes no payment, that limit will ordinarily be the latter.",
            "You accept that this allocation of risk is reasonable given that the service is offered free of charge during early access.",
          ],
        },
        {
          heading: "Indemnity",
          paragraphs: [
            "You will indemnify us against claims, damages and reasonable costs arising from your breach of these terms, your misuse of the service, or your infringement of someone else's rights. We will tell you promptly of any such claim and will not settle it without your consent, which you will not unreasonably withhold.",
          ],
        },
        {
          heading: "Ending the agreement",
          paragraphs: [
            "You may stop using the service at any time. To have your account deleted, write to us and we will do it; deletion removes your personal data and ends every session, and any credits are forfeited.",
            "We may suspend or end your access for a material breach of these terms, or where required by law. Where the breach can be fixed and the circumstances allow, we will tell you and give you a reasonable chance to fix it first.",
            "The clauses that by their nature should survive termination — ownership, disclaimers, limitation of liability, indemnity, and governing law — do survive it.",
          ],
        },
        {
          heading: "Governing law and disputes",
          paragraphs: [
            "These terms are governed by the laws of India, without regard to conflict-of-law rules. The courts of Pune, Maharashtra have exclusive jurisdiction, except that we may seek injunctive relief in any competent court to protect our intellectual property.",
            "If you are a consumer resident elsewhere, this does not deprive you of the protection of mandatory consumer-protection rules of your country of residence, or of the right to bring proceedings in your local courts where the law gives you that right.",
            "Before starting proceedings, please contact us. Most disputes are resolved faster by email than by litigation, and we would rather fix the problem.",
          ],
        },
        {
          heading: "General",
          paragraphs: [
            "If any provision is held unenforceable, the rest continues in force and that provision is applied as far as it lawfully can be. Our not enforcing a term is not a waiver of it.",
            "You may not assign these terms without our written consent. We may assign them to a successor in connection with a merger, acquisition, or sale of assets, on notice to you.",
            "These terms, together with the Privacy Policy, Cookie Policy and Acceptable Use Policy, are the entire agreement between us about the service, and replace any earlier understanding.",
            `Notices to us should go to ${LEGAL_CONTACT}. Notices to you will go to the email address on your account, and are treated as received when sent.`,
          ],
        },
      ]}
    />
  );
}

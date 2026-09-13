import type { Route } from "./+types/security";
import { buildMeta } from "../../lib/seo";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Security at Inkloom",
    description:
      "How Inkloom protects accounts, credits and personal data — and how to report a problem.",
    path: location.pathname,
  });
}

/**
 * The security page.
 *
 * Everything claimed here is implemented and tested. Nothing aspirational is
 * listed as though it were shipped — that is the whole reason a page like this
 * is worth publishing.
 */
export default function SecurityPage() {
  return (
    <>
      <section className="measure" style={{ paddingBlock: "clamp(3rem, 7vw, 5rem) 2.5rem" }}>
        <h1 style={{ fontSize: "clamp(2.25rem, 5.5vw, var(--text-h1))", maxWidth: "14ch" }}>
          Security
        </h1>
        <p
          style={{
            marginTop: "1.5rem",
            fontSize: "var(--text-lead)",
            color: "var(--color-ink-soft)",
            maxWidth: "52ch",
          }}
        >
          What is actually in place today. If something here is not true, that is a bug and we want
          to hear about it.
        </p>
      </section>

      <section className="measure" style={{ paddingBottom: "clamp(3rem, 6vw, 4.5rem)" }}>
        {[
          {
            heading: "Accounts",
            items: [
              [
                "Passwords",
                "Hashed with scrypt by an audited authentication library. We never see, store or log the original, and nothing on our side can recover it.",
              ],
              [
                "Minimum length, no silly rules",
                "Twelve characters, no forced symbols or forced rotation — both of which push people toward weaker, more predictable passwords. Password managers and pasting work everywhere.",
              ],
              ["Email verification", "Required before you can sign in or receive any credits."],
              [
                "Two-factor authentication",
                "Available to everyone, and mandatory for every Inkloom staff account.",
              ],
              [
                "Login protection",
                "Repeated failures trigger a progressive cooldown and a bot challenge. We never permanently lock an account — that would be a denial-of-service anyone could trigger against you.",
              ],
            ],
          },
          {
            heading: "Sessions",
            items: [
              [
                "HttpOnly cookies",
                "Your session lives in a cookie JavaScript cannot read, marked Secure, SameSite and host-only. Nothing is kept in local storage.",
              ],
              [
                "Server-side validation",
                "Every request re-checks the session against the database, so revoking one takes effect on the very next request rather than whenever a token expires.",
              ],
              [
                "You control your devices",
                "See every signed-in device and end any of them, or all of them, from your account.",
              ],
              [
                "Automatic rotation",
                "Changing your password or resetting it ends every other session.",
              ],
            ],
          },
          {
            heading: "Your data",
            items: [
              [
                "No raw IP addresses",
                "For abuse monitoring we store a rotating keyed hash instead. It allows correlation within a day and cannot be reversed to an address.",
              ],
              [
                "Minimal device data",
                "We keep a coarse label like “Chrome on macOS”, never a fingerprint or a full user-agent string.",
              ],
              [
                "Export whenever you want",
                "One click gives you everything we hold: profile, credit history, redemptions, consents and sessions.",
              ],
              [
                "Deletion means deletion",
                "Your personal details are removed and every session ends. We keep an anonymised accounting record of credit grants, because we are required to, with nothing personal attached.",
              ],
            ],
          },
          {
            heading: "Credits",
            items: [
              [
                "An immutable ledger",
                "Every credit change is an entry that cannot be edited or deleted — the database itself forbids it. Corrections are appended as reversals, so history stays honest.",
              ],
              [
                "Balances that reconcile",
                "Your balance is recomputed from the ledger and compared; a mismatch is treated as a bug, not rounded away.",
              ],
              [
                "Access codes are never stored",
                "Only a keyed hash. A stolen database yields no redeemable codes.",
              ],
              [
                "Nothing double-grants",
                "Simultaneous redemption attempts are resolved by the database, so a code can only ever be redeemed once per account.",
              ],
            ],
          },
          {
            heading: "The platform",
            items: [
              ["HTTPS everywhere", "With HSTS, so a browser will not fall back to plain HTTP."],
              [
                "Strict content policy",
                "A Content-Security-Policy that forbids inline scripts, framing, and loading code from anywhere we have not allowed.",
              ],
              [
                "Audited admin actions",
                "Every consequential staff action is recorded with who did it, when, and why — in a log the application cannot rewrite.",
              ],
              [
                "Least privilege",
                "Staff roles are separated, and the actions that move credits or grant access are restricted to a single super-admin role.",
              ],
            ],
          },
        ].map((group) => (
          <div key={group.heading} style={{ marginBottom: "2.5rem" }}>
            <h2 style={{ fontSize: "var(--text-h3)", marginBottom: "1rem" }}>{group.heading}</h2>
            <dl className="sec-list">
              {group.items.map(([term, detail]) => (
                <div key={term}>
                  <dt>{term}</dt>
                  <dd>{detail}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </section>

      <section className="measure" style={{ paddingBottom: "clamp(3rem, 6vw, 4.5rem)" }}>
        <div
          style={{
            border: "1px solid var(--color-ink)",
            padding: "clamp(1.75rem, 4vw, 2.5rem)",
            maxWidth: "44rem",
          }}
        >
          <h2 style={{ fontSize: "var(--text-h3)" }}>Reporting a vulnerability</h2>
          <p style={{ marginTop: "1rem", color: "var(--color-muted)" }}>
            Email <a href="mailto:security@inkloom.art">security@inkloom.art</a> with enough detail
            to reproduce it. We will acknowledge within two working days and keep you updated.
          </p>
          <p style={{ marginTop: "0.75rem", color: "var(--color-muted)" }}>
            We will not pursue or support action against anyone who reports in good faith, stays
            within their own account, and gives us reasonable time before disclosing. Please do not
            run automated scanning against production, and never access another person's data to
            prove a point — tell us and we will verify it ourselves.
          </p>
        </div>
      </section>

      <style>{`
        .sec-list { margin: 0; padding: 0; border-top: 1px solid var(--color-rule); }
        .sec-list > div { padding: 1rem 0; border-bottom: 1px solid var(--color-rule-soft); }
        .sec-list dt { font-weight: 600; }
        .sec-list dd { margin: 0.25rem 0 0; color: var(--color-muted); max-width: 62ch; }
        @media (min-width: 850px) {
          .sec-list > div { display: grid; grid-template-columns: 26ch 1fr; gap: 2rem; align-items: baseline; }
          .sec-list dd { margin-top: 0; }
        }
      `}</style>
    </>
  );
}

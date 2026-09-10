import { Form, useActionData, useNavigation } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/contact";
import { buildMeta } from "../../lib/seo";
import { call, fieldErrors } from "../../lib/api";
import { Field, Notice, Select, TextArea } from "../../components/ui";
import { Turnstile, type TurnstileStatus } from "../../components/turnstile";
import { servicesContext } from "../../lib/context";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Contact Inkloom",
    description: "Ask a question, report a problem, or tell us what you need.",
    path: location.pathname,
  });
}

export async function loader({ context }: Route.LoaderArgs) {
  const { config, settings } = context.get(servicesContext);
  return {
    turnstileSiteKey: config.TURNSTILE_ENABLED ? config.TURNSTILE_SITE_KEY : null,
    supportEmail: config.SUPPORT_EMAIL,
    open: await settings.isEnabled("support_form_enabled"),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();

  const result = await call<{ reference: string }>("/support", {
    method: "POST",
    request,
    body: {
      email: String(form.get("email") ?? ""),
      name: String(form.get("name") ?? ""),
      category: String(form.get("category") ?? "other"),
      subject: String(form.get("subject") ?? ""),
      message: String(form.get("message") ?? ""),
      turnstileToken: String(form.get("cf-turnstile-response") ?? ""),
      context: { path: "/contact" },
    },
  });

  return result.error
    ? { error: result.error.message, fields: fieldErrors(result.error), reference: null }
    : {
        error: null,
        fields: {} as Record<string, string>,
        reference: result.data?.reference ?? null,
      };
}

export default function Contact({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [checkStatus, setCheckStatus] = useState<TurnstileStatus>("pending");
  /**
   * The check must have produced a token before this form can be sent.
   *
   * Blocked while `pending` AND while `unavailable`: the server refuses a
   * missing token either way, so a live button would only buy a refusal that
   * reads as an accusation. The Turnstile component explains the situation and
   * offers a retry underneath.
   */
  const checkBlocked = Boolean(loaderData.turnstileSiteKey) && checkStatus !== "verified";
  const checkFailed = checkStatus === "unavailable";

  if (actionData?.reference) {
    return (
      <section
        className="measure"
        style={{ paddingBlock: "clamp(3rem, 7vw, 5rem)", maxWidth: "44rem" }}
      >
        <h1 style={{ fontSize: "var(--text-h2)" }}>Message received</h1>
        <p
          style={{
            marginTop: "1rem",
            fontSize: "var(--text-lead)",
            color: "var(--color-ink-soft)",
          }}
        >
          Your reference is <strong>{actionData.reference}</strong>. We have emailed you a copy.
        </p>
        <p style={{ marginTop: "1rem", color: "var(--color-muted)" }}>
          A person reads every message. We usually reply within two working days — quote that
          reference if you follow up.
        </p>
      </section>
    );
  }

  return (
    <section
      className="measure"
      style={{ paddingBlock: "clamp(3rem, 7vw, 5rem) clamp(3rem, 6vw, 4.5rem)" }}
    >
      <div className="contact-grid">
        <div>
          <h1 style={{ fontSize: "clamp(2.25rem, 5.5vw, var(--text-h1))", maxWidth: "12ch" }}>
            Get in touch
          </h1>
          <p
            style={{
              marginTop: "1.5rem",
              fontSize: "var(--text-lead)",
              color: "var(--color-ink-soft)",
            }}
          >
            Questions, problems, or something you need Inkloom to do. We read everything.
          </p>

          <dl className="contact-facts">
            <div>
              <dt>Support</dt>
              <dd>
                <a href={`mailto:${loaderData.supportEmail}`}>{loaderData.supportEmail}</a>
              </dd>
            </div>
            <div>
              <dt>Security reports</dt>
              <dd>
                <a href="mailto:security@inkloom.com">security@inkloom.com</a>
              </dd>
            </div>
            <div>
              <dt>Typical reply</dt>
              <dd>Within two working days</dd>
            </div>
          </dl>

          <p
            style={{
              marginTop: "1.5rem",
              fontSize: "var(--text-fine)",
              color: "var(--color-muted)",
            }}
          >
            Never include your password. Nobody at Inkloom will ever ask for it.
          </p>
        </div>

        <div>
          {!loaderData.open ? (
            <Notice tone="caution" title="The form is temporarily closed">
              Email us at {loaderData.supportEmail} and we will pick it up.
            </Notice>
          ) : (
            <>
              {actionData?.error && (
                <div style={{ marginBottom: "1.25rem" }}>
                  <Notice tone="critical">{actionData.error}</Notice>
                </div>
              )}

              <Form method="post" style={{ display: "grid", gap: "1.125rem" }}>
                <Field label="Your name" name="name" maxLength={80} autoComplete="name" />
                <Field
                  label="Email address"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  required
                  error={actionData?.fields?.email}
                  hint="So we can reply."
                />
                <Select
                  label="What is this about?"
                  name="category"
                  options={[
                    { value: "account", label: "My account" },
                    { value: "access_code", label: "An access code" },
                    { value: "bug", label: "Something is broken" },
                    { value: "security", label: "A security concern" },
                    { value: "feedback", label: "Feedback or a request" },
                    { value: "other", label: "Something else" },
                  ]}
                />
                <Field
                  label="Subject"
                  name="subject"
                  required
                  minLength={3}
                  maxLength={150}
                  error={actionData?.fields?.subject}
                />
                <TextArea
                  label="Your message"
                  name="message"
                  required
                  minLength={10}
                  maxLength={5000}
                  error={actionData?.fields?.message}
                />

                {loaderData.turnstileSiteKey && (
                  <Turnstile
                    siteKey={loaderData.turnstileSiteKey}
                    action="contact"
                    onStatusChange={setCheckStatus}
                  />
                )}

                <div>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={navigation.state === "submitting" || checkBlocked}
                  >
                    {navigation.state === "submitting"
                      ? "Sending…"
                      : checkFailed
                        ? "Human check unavailable"
                        : checkBlocked
                          ? "Checking you're human…"
                          : "Send message"}
                  </button>
                </div>
              </Form>
            </>
          )}
        </div>
      </div>

      <style>{`
        .contact-grid { display: grid; gap: 3rem; }
        .contact-facts { margin: 2rem 0 0; padding: 0; border-top: 1px solid var(--color-rule); }
        .contact-facts > div { display: flex; justify-content: space-between; gap: 1.5rem; padding: 0.75rem 0; border-bottom: 1px solid var(--color-rule-soft); font-size: var(--text-fine); }
        .contact-facts dt { color: var(--color-muted); }
        .contact-facts dd { margin: 0; text-align: right; }
        @media (min-width: 900px) { .contact-grid { grid-template-columns: 0.9fr 1.1fr; gap: 4rem; } }
      `}</style>
    </section>
  );
}

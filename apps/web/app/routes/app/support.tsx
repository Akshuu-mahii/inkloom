import { Form, useActionData, useNavigation, useOutletContext } from "react-router";
import type { Route } from "./+types/support";
import { call, fieldErrors, type Me } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Field, Notice, PageHeader, Select, TextArea } from "../../components/ui";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Support",
    description: "Get help with your Inkloom account.",
    path: location.pathname,
    noindex: true,
  });
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
      context: { path: "/app/support" },
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

export default function Support() {
  const { me } = useOutletContext<{ me: Me }>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();

  if (actionData?.reference) {
    return (
      <>
        <PageHeader title="Support" />
        <Notice tone="positive" title={`Your reference is ${actionData.reference}`}>
          We have emailed you a copy. We read every message and usually reply within two working
          days — quote that reference if you follow up.
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Support" description="Tell us what is going on and we will help." />

      {actionData?.error && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="critical">{actionData.error}</Notice>
        </div>
      )}

      <Form method="post" style={{ display: "grid", gap: "1.125rem", maxWidth: "34rem" }}>
        <input type="hidden" name="email" value={me.email} />
        <input type="hidden" name="name" value={me.name} />

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
          maxLength={150}
          error={actionData?.fields?.subject}
        />

        <TextArea
          label="What happened?"
          name="message"
          required
          maxLength={5000}
          hint="Include anything that helps: what you did, what you expected, what happened instead."
          error={actionData?.fields?.message}
        />

        <p className="field-hint">
          Sending from {me.email}. Never include your password — we will never ask for it.
        </p>

        <div>
          <button
            type="submit"
            className="btn btn-ink"
            disabled={navigation.state === "submitting"}
          >
            {navigation.state === "submitting" ? "Sending…" : "Send message"}
          </button>
        </div>
      </Form>
    </>
  );
}

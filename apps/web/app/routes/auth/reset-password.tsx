import { Form, Link, redirect, useActionData, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/reset-password";
import { AuthHeading } from "./layout";
import { Field, Notice } from "../../components/ui";
import { call, fieldErrors } from "../../lib/api";
import { buildMeta } from "../../lib/seo";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Choose a new password",
    description: "Set a new password on your Inkloom account.",
    path: location.pathname,
    noindex: true,
  });
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirmPassword") ?? "");

  // Checked here as well as client-side, because the client check is optional.
  if (password !== confirm) {
    // Widened to the same shape the API path returns, so the component sees one
    // consistent `fields` type rather than a union it has to narrow.
    const fields: Record<string, string> = {
      confirmPassword: "Both passwords need to match.",
    };
    return { fields, error: null };
  }

  const result = await call("/auth/reset-password", {
    method: "POST",
    request,
    body: { token: String(form.get("token") ?? ""), password },
  });

  if (result.error) {
    return { error: result.error, fields: fieldErrors(result.error) };
  }

  // Every session was revoked by the reset, so the user signs in fresh.
  return redirect("/auth/login?notice=password-reset");
}

export default function ResetPassword() {
  const [params] = useSearchParams();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const token = params.get("token") ?? "";

  if (!token) {
    return (
      <>
        <AuthHeading title="This page needs a reset link">
          Open the link from your email, or request a new one.
        </AuthHeading>
        <Link to="/auth/forgot-password" className="btn btn-ink" style={{ width: "100%" }}>
          Request a reset link
        </Link>
      </>
    );
  }

  const fields = actionData?.fields ?? {};

  return (
    <>
      <AuthHeading title="Choose a new password">
        Pick something you have not used elsewhere.
      </AuthHeading>

      {actionData?.error && (
        <div style={{ marginBottom: "1.25rem" }}>
          <Notice tone="critical" title="Could not reset your password">
            {actionData.error.message}{" "}
            {fields.token && <Link to="/auth/forgot-password">Request a new link</Link>}
          </Notice>
        </div>
      )}

      <Form method="post" style={{ display: "grid", gap: "1.125rem" }}>
        <input type="hidden" name="token" value={token} />

        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
          // Uncontrolled: see the note in signup.tsx — a controlled value is
          // wiped by hydration if the user types before JavaScript loads.
          hint="At least 6 characters, including a letter, a number and a special character."
          error={fields.password}
          autoFocus
        />

        <Field
          label="Confirm new password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          error={fields.confirmPassword}
        />

        <Notice tone="info">
          Setting a new password signs you out everywhere else, on every device.
        </Notice>

        <button type="submit" className="btn btn-ink" disabled={navigation.state === "submitting"}>
          {navigation.state === "submitting" ? "Saving…" : "Save new password"}
        </button>
      </Form>
    </>
  );
}

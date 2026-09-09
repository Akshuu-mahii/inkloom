import { Form, Link, useActionData, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/check-email";
import { AuthHeading } from "./layout";
import { Notice } from "../../components/ui";
import { call } from "../../lib/api";
import { buildMeta } from "../../lib/seo";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Check your email",
    description: "Confirm your email address to finish setting up your Inkloom account.",
    path: location.pathname,
    noindex: true,
  });
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  // The response is identical for a known and an unknown address, so nothing
  // here can be used to test whether an account exists.
  await call("/auth/resend-verification", {
    method: "POST",
    request,
    body: { email: String(form.get("email") ?? "") },
  });
  return { resent: true };
}

export default function CheckEmail() {
  const [params] = useSearchParams();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const email = params.get("to") ?? "";

  return (
    <>
      <AuthHeading title="Confirm your email">
        {email ? (
          <>
            If <strong style={{ color: "var(--color-ink)" }}>{email}</strong> needs an email from
            us, it is on its way. Open it and click the link to finish.
          </>
        ) : (
          "If that address needs an email from us, it is on its way. Open it and click the link to finish."
        )}
      </AuthHeading>

      <Notice tone="info" title="The link expires in 24 hours">
        It can only be used once. If it expires, request a new one below and any earlier link stops
        working.
      </Notice>

      {actionData?.resent && (
        <div style={{ marginTop: "1rem" }}>
          <Notice tone="positive">
            Sent. Check your inbox, and your spam folder if it is not there in a minute.
          </Notice>
        </div>
      )}

      <Form method="post" style={{ marginTop: "1.75rem" }}>
        <input type="hidden" name="email" value={email} />
        <button
          type="submit"
          className="btn btn-quiet"
          disabled={navigation.state === "submitting"}
          style={{ width: "100%" }}
        >
          {navigation.state === "submitting" ? "Sending…" : "Send the email again"}
        </button>
      </Form>

      <p style={{ marginTop: "1.5rem", fontSize: "var(--text-fine)", color: "var(--color-muted)" }}>
        Wrong address? <Link to="/auth/signup">Start again</Link> · Already confirmed?{" "}
        <Link to="/auth/login">Sign in</Link>
      </p>
    </>
  );
}

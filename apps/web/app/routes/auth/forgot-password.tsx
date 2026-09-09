import { useState } from "react";
import { Form, Link, useActionData, useNavigation } from "react-router";
import type { Route } from "./+types/forgot-password";
import { AuthHeading } from "./layout";
import { Field, Notice } from "../../components/ui";
import { Turnstile } from "../../components/turnstile";
import { call } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { servicesContext } from "../../lib/context";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Reset your password",
    description: "Request a link to set a new password on your Inkloom account.",
    path: location.pathname,
    noindex: true,
  });
}

export async function loader({ context }: Route.LoaderArgs) {
  const { config } = context.get(servicesContext);
  return { turnstileSiteKey: config.TURNSTILE_ENABLED ? config.TURNSTILE_SITE_KEY : null };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const result = await call("/auth/forgot-password", {
    method: "POST",
    request,
    body: {
      email: String(form.get("email") ?? ""),
      turnstileToken: String(form.get("cf-turnstile-response") ?? ""),
    },
  });

  // Only a rate limit or a failed challenge produces an error. A non-existent
  // address returns success, exactly like a real one.
  if (result.error && result.status !== 200) {
    return { error: result.error };
  }
  return { sent: true };
}

export default function ForgotPassword({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [verified, setVerified] = useState(false);

  if (actionData?.sent) {
    return (
      <>
        <AuthHeading title="Check your email">
          If that address has an Inkloom account, a reset link is on its way.
        </AuthHeading>
        <Notice tone="info" title="The link expires in one hour">
          It can only be used once, and requesting another immediately invalidates this one.
        </Notice>
        <p style={{ marginTop: "1.75rem", fontSize: "var(--text-fine)" }}>
          <Link to="/auth/login">Back to sign in</Link>
        </p>
      </>
    );
  }

  return (
    <>
      <AuthHeading title="Reset your password">
        Enter your email address and we will send you a link to set a new password.
      </AuthHeading>

      {actionData?.error && (
        <div style={{ marginBottom: "1.25rem" }}>
          <Notice tone="critical">{actionData.error.message}</Notice>
        </div>
      )}

      <Form method="post" style={{ display: "grid", gap: "1.125rem" }}>
        <Field
          label="Email address"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          required
          autoFocus
        />
        {loaderData.turnstileSiteKey && (
          <Turnstile
            siteKey={loaderData.turnstileSiteKey}
            action="forgot-password"
            onReady={setVerified}
          />
        )}
        <button
          type="submit"
          className="btn btn-ink"
          /* Held until Turnstile has a token, so nobody submits into a
             guaranteed "we couldn't verify you're human" rejection. */
          disabled={
            navigation.state === "submitting" || (Boolean(loaderData.turnstileSiteKey) && !verified)
          }
        >
          {navigation.state === "submitting"
            ? "Sending…"
            : loaderData.turnstileSiteKey && !verified
              ? "Checking you're human…"
              : "Send reset link"}
        </button>
      </Form>

      <p style={{ marginTop: "1.5rem", fontSize: "var(--text-fine)", color: "var(--color-muted)" }}>
        Remembered it? <Link to="/auth/login">Sign in</Link>
      </p>
    </>
  );
}

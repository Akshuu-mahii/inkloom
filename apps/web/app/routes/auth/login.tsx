import { Form, Link, redirect, useActionData, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/login";
import { AuthHeading } from "./layout";
import { Field, Notice } from "../../components/ui";
import { Turnstile } from "../../components/turnstile";
import { call, withCookies } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { servicesContext } from "../../lib/context";
import { safeRedirectPath } from "@inkloom/core/security";
import { BusyLabel } from "../../components/infinity-mark";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Sign in to Inkloom",
    description: "Sign in to your Inkloom account.",
    path: location.pathname,
    noindex: true,
  });
}

export async function loader({ context }: Route.LoaderArgs) {
  const { config } = context.get(servicesContext);
  return {
    turnstileSiteKey: config.TURNSTILE_ENABLED ? config.TURNSTILE_SITE_KEY : null,
    googleEnabled: config.googleOAuthEnabled,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();

  const result = await call<{ redirectTo?: string; twoFactorRequired?: boolean }>("/auth/login", {
    method: "POST",
    request,
    body: {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
      turnstileToken: String(form.get("cf-turnstile-response") ?? ""),
      rememberMe: form.get("rememberMe") !== null,
    },
  });

  if (result.error) {
    return {
      error: result.error,
      // The server tells us when a challenge is now required, so the form can
      // render one on the next attempt without guessing.
      challengeRequired: Boolean(
        (result.error.details as { challengeRequired?: boolean } | undefined)?.challengeRequired,
      ),
      retryAfter: result.status === 429 ? true : false,
    };
  }

  /**
   * Forward the API's Set-Cookie onto the redirect.
   *
   * Without this the sign-in "succeeds" and the very next request is anonymous:
   * a server-side `fetch` receives cookies but does not pass them on, because
   * the Worker is the CLIENT of that call, not a proxy. The strings are copied
   * verbatim so the `__Host-` prefix and every attribute survive.
   */
  const headers = withCookies(result);

  if (result.data?.twoFactorRequired) {
    // No session exists yet — Better Auth issued a challenge instead. The
    // cookie being forwarded here is the short-lived 2FA challenge cookie.
    return redirect("/auth/two-factor", { headers });
  }

  /**
   * `next` is validated server-side before it is used. Reflecting it unchecked
   * would turn every login link into an open redirect.
   */
  const next = safeRedirectPath(new URL(request.url).searchParams.get("next"), "/app");
  return redirect(next, { headers });
}
export default function Login({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();

  const submitting = navigation.state === "submitting";
  const needsChallenge = Boolean(actionData?.challengeRequired);
  const notice = searchParams.get("notice");

  return (
    <>
      <AuthHeading title="Sign in">Welcome back.</AuthHeading>

      {notice === "verified" && (
        <div style={{ marginBottom: "1.25rem" }}>
          <Notice tone="positive" title="Email confirmed">
            Your address is verified. Sign in to reach your dashboard.
          </Notice>
        </div>
      )}
      {notice === "password-reset" && (
        <div style={{ marginBottom: "1.25rem" }}>
          <Notice tone="positive" title="Password updated">
            Sign in with your new password.
          </Notice>
        </div>
      )}
      {notice === "signed-out" && (
        <div style={{ marginBottom: "1.25rem" }}>
          <Notice tone="info">You have been signed out.</Notice>
        </div>
      )}

      {actionData?.error && (
        <div style={{ marginBottom: "1.25rem" }}>
          <Notice
            tone={actionData.retryAfter ? "caution" : "critical"}
            title={actionData.retryAfter ? "Too many attempts" : "Could not sign you in"}
          >
            {actionData.error.message}
          </Notice>
        </div>
      )}

      <Form method="post" replace style={{ display: "grid", gap: "1.125rem" }}>
        <Field
          label="Email address"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          required
          autoFocus
        />

        <div>
          <Field
            label="Password"
            name="password"
            type="password"
            /* `current-password` so managers autofill rather than offer to
               generate, and nothing here blocks pasting. */
            autoComplete="current-password"
            required
          />
          <p style={{ marginTop: "0.5rem", fontSize: "var(--text-fine)" }}>
            <Link to="/auth/forgot-password">Forgot your password?</Link>
          </p>
        </div>

        <label
          style={{
            display: "flex",
            gap: "0.625rem",
            alignItems: "center",
            fontSize: "var(--text-fine)",
            color: "var(--color-muted)",
          }}
        >
          <input type="checkbox" name="rememberMe" defaultChecked />
          <span>Keep me signed in on this device</span>
        </label>

        {/* Only after repeated failures, so an honest first attempt is frictionless. */}
        {needsChallenge && loaderData.turnstileSiteKey && (
          <Turnstile siteKey={loaderData.turnstileSiteKey} action="login" />
        )}

        <button type="submit" className="btn btn-ink" disabled={submitting}>
          {submitting ? <BusyLabel>Signing in…</BusyLabel> : "Sign in"}
        </button>
      </Form>

      {loaderData.googleEnabled && (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              margin: "1.5rem 0",
              color: "var(--color-muted)",
              fontSize: "var(--text-micro)",
            }}
          >
            <hr className="rule" style={{ flex: 1 }} />
            <span>or</span>
            <hr className="rule" style={{ flex: 1 }} />
          </div>
          {/*
            A form post to our own route, not a link at the API.

            Better Auth's social sign-in is a POST that answers with the URL to
            follow, so the old `<a href="/api/auth/sign-in/social?...">` was not
            a route at all and returned 404. `/auth/google` does the POST and
            redirects. Posting also stops a cross-site image or a prefetch from
            starting the flow.
          */}
          <Form method="post" action="/auth/google">
            <button type="submit" className="btn btn-outline" style={{ width: "100%" }}>
              Continue with Google
            </button>
          </Form>
        </>
      )}

      <p style={{ marginTop: "1.5rem", fontSize: "var(--text-fine)", color: "var(--color-muted)" }}>
        New to Inkloom? <Link to="/auth/signup">Create an account</Link>
      </p>
    </>
  );
}

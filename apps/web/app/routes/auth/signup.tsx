import { Form, Link, redirect, useActionData, useNavigation, useSearchParams } from "react-router";
import { useRef, useState } from "react";
import type { Route } from "./+types/signup";
import { AuthHeading } from "./layout";
import { Field, Notice } from "../../components/ui";
import { Turnstile, type TurnstileStatus } from "../../components/turnstile";
import { call, fieldErrors } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { servicesContext } from "../../lib/context";
import { track } from "../../lib/analytics";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Create your Inkloom account",
    description:
      "Create an Inkloom account to join early access and reserve your promotional credits.",
    path: location.pathname,
    // Auth pages carry no content worth ranking and should not appear in results.
    noindex: true,
  });
}

/**
 * The site key is public by definition — it is rendered into the widget — so
 * passing it to the client is correct. The SECRET key never leaves the server
 * and is only used by `TurnstileVerifier` when validating the token.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { config, settings } = context.get(servicesContext);
  return {
    turnstileSiteKey: config.TURNSTILE_ENABLED ? config.TURNSTILE_SITE_KEY : null,
    signupEnabled: await settings.isEnabled("signup_enabled"),
    googleEnabled: config.googleOAuthEnabled,
  };
}

/**
 * Server action.
 *
 * The form posts here, so signup works with JavaScript disabled and the
 * server remains the authority on validation. Client-side checks below are a
 * convenience, never a gate.
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();

  const result = await call<{ nextPath?: string }>("/auth/signup", {
    method: "POST",
    request,
    body: {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
      name: String(form.get("name") ?? ""),
      acceptedTerms: form.get("acceptedTerms") === "on",
      marketingOptIn: form.get("marketingOptIn") === "on",
      turnstileToken: String(form.get("cf-turnstile-response") ?? ""),
      utm: readUtm(request),
    },
  });

  if (result.error) {
    return { error: result.error, fields: fieldErrors(result.error) };
  }

  // The response is identical whether the address was new or already
  // registered, so this redirect leaks nothing either way.
  const email = String(form.get("email") ?? "");
  return redirect(`/auth/check-email?to=${encodeURIComponent(email)}`);
}

/** First-touch attribution, read from the URL. Never contains personal data. */
function readUtm(request: Request) {
  const params = new URL(request.url).searchParams;
  const utm = {
    source: params.get("utm_source") ?? undefined,
    medium: params.get("utm_medium") ?? undefined,
    campaign: params.get("utm_campaign") ?? undefined,
    referrer: request.headers.get("referer") ?? undefined,
    landingPath: new URL(request.url).pathname,
  };
  return Object.values(utm).some(Boolean) ? utm : undefined;
}

export default function Signup({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const [password, setPassword] = useState("");
  const [checkStatus, setCheckStatus] = useState<TurnstileStatus>("pending");
  const startedRef = useRef(false);

  const submitting = navigation.state === "submitting";
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
  const fields = actionData?.fields ?? {};

  if (!loaderData.signupEnabled) {
    return (
      <>
        <AuthHeading title="Registration is paused">
          We have temporarily closed new signups. This is usually brief.
        </AuthHeading>
        <Notice tone="caution">
          If you were expecting to join now, <Link to="/contact">let us know</Link> and we will sort
          it out.
        </Notice>
      </>
    );
  }

  return (
    <>
      <AuthHeading title="Create your account">
        Join early access, redeem a code, and your credits wait until generation opens.
      </AuthHeading>

      {actionData?.error && !Object.keys(fields).length && (
        <div style={{ marginBottom: "1.25rem" }}>
          <Notice tone="critical" title="Could not create your account">
            {actionData.error.message}
          </Notice>
        </div>
      )}

      <Form
        method="post"
        replace
        style={{ display: "grid", gap: "1.125rem" }}
        // Fires once, on the first interaction with the form, so the funnel
        // distinguishes "opened the page" from "actually started filling it in".
        onFocusCapture={() => {
          if (!startedRef.current) {
            startedRef.current = true;
            track("signup_started");
          }
        }}
      >
        <Field
          label="Your name"
          name="name"
          type="text"
          autoComplete="name"
          required
          maxLength={80}
          error={fields.name}
        />

        <Field
          label="Email address"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          defaultValue={searchParams.get("email") ?? ""}
          error={fields.email}
        />

        <div>
          <Field
            label="Password"
            name="password"
            type="password"
            /* `new-password` lets a password manager offer to generate one. */
            autoComplete="new-password"
            required
            minLength={12}
            /**
             * UNCONTROLLED on purpose.
             *
             * A controlled `value` is reset to React's initial state ("") the
             * moment hydration runs, so anything typed before the JavaScript
             * loaded is silently thrown away — the field looks full, and an
             * empty password is submitted. `onChange` still drives the strength
             * meter, but the input owns its own value.
             */
            onChange={(event) => setPassword(event.target.value)}
            hint="At least 12 characters. A short phrase is easier to remember and harder to guess."
            error={fields.password}
          />
          <PasswordStrength value={password} />
        </div>

        <label
          style={{
            display: "flex",
            gap: "0.625rem",
            alignItems: "flex-start",
            fontSize: "var(--text-fine)",
            lineHeight: 1.5,
          }}
        >
          {/* Unticked by default: consent has to be given, not withdrawn. */}
          <input type="checkbox" name="acceptedTerms" required style={{ marginTop: "0.2rem" }} />
          <span>
            I agree to the <Link to="/terms">Terms</Link> and the{" "}
            <Link to="/privacy">Privacy Policy</Link>.
          </span>
        </label>

        <label
          style={{
            display: "flex",
            gap: "0.625rem",
            alignItems: "flex-start",
            fontSize: "var(--text-fine)",
            lineHeight: 1.5,
            color: "var(--color-muted)",
          }}
        >
          <input type="checkbox" name="marketingOptIn" style={{ marginTop: "0.2rem" }} />
          <span>
            Email me occasional product updates. Separate from account emails, and you can turn it
            off any time.
          </span>
        </label>

        {loaderData.turnstileSiteKey && (
          <Turnstile siteKey={loaderData.turnstileSiteKey} onStatusChange={setCheckStatus} />
        )}

        <button
          type="submit"
          className="btn btn-primary"
          /* Held until Turnstile has produced a token, so nobody submits into a
             guaranteed rejection. */
          disabled={submitting || checkBlocked}
        >
          {submitting
            ? "Creating your account…"
            : checkFailed
              ? "Human check unavailable"
              : checkBlocked
                ? "Checking you're human…"
                : "Create account"}
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
            A plain link, not a form POST — same reasoning as the sign-in page:
            the API refuses urlencoded bodies on state-changing requests, and
            nothing is mutated until the provider redirects back with a code.

            Signing up through Google skips email verification, because Google
            has already proven the address. It also accepts the terms, which is
            why the link says so plainly rather than burying it.
          */}
          <a
            href="/api/auth/sign-in/social?provider=google&callbackURL=/app"
            className="btn btn-outline"
            style={{ width: "100%" }}
            rel="nofollow"
          >
            Continue with Google
          </a>
          <p
            style={{
              marginTop: "0.625rem",
              fontSize: "var(--text-micro)",
              color: "var(--color-muted)",
              lineHeight: 1.5,
            }}
          >
            Continuing with Google creates your account and accepts the{" "}
            <Link to="/terms">Terms</Link> and <Link to="/privacy">Privacy Policy</Link>.
          </p>
        </>
      )}

      <p
        style={{
          marginTop: "1.5rem",
          fontSize: "var(--text-fine)",
          color: "var(--color-muted)",
        }}
      >
        Already have an account? <Link to="/auth/login">Sign in</Link>
      </p>
    </>
  );
}

/**
 * Password feedback.
 *
 * Length-based, because length is what actually resists guessing. It reports
 * strength but never BLOCKS on composition — no "must contain a symbol" rule,
 * which NIST advises against and which pushes people toward "Password1!".
 */
function PasswordStrength({ value }: { value: string }) {
  if (!value) return null;

  const length = value.length;
  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;

  const score = length >= 20 ? 3 : length >= 16 ? 2 : length >= 12 ? (variety >= 2 ? 2 : 1) : 0;

  const labels = ["Too short", "Workable", "Good", "Strong"] as const;
  const colors = [
    "var(--color-critical)",
    "var(--color-caution)",
    "var(--color-positive)",
    "var(--color-positive)",
  ] as const;

  return (
    <div style={{ marginTop: "0.5rem" }} aria-live="polite">
      <div style={{ display: "flex", gap: "3px" }}>
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            aria-hidden="true"
            style={{
              height: "3px",
              flex: 1,
              background: index <= score ? colors[score] : "var(--color-rule-soft)",
            }}
          />
        ))}
      </div>
      {/* The word carries the meaning, so the bar colour is never the only signal. */}
      <p style={{ marginTop: "0.375rem", fontSize: "var(--text-micro)", color: colors[score] }}>
        {labels[score]}
        {score === 0 && ` — ${12 - length} more character${12 - length === 1 ? "" : "s"} needed`}
      </p>
    </div>
  );
}

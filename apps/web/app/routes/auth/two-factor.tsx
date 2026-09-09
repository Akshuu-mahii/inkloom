import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import type { Route } from "./+types/two-factor";
import { AuthHeading } from "./layout";
import { Field, Notice } from "../../components/ui";
import { call, withCookies } from "../../lib/api";
import { buildMeta } from "../../lib/seo";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Two-factor verification",
    description: "Enter your two-factor code to finish signing in.",
    path: location.pathname,
    noindex: true,
  });
}

/**
 * The second factor.
 *
 * Posts to a server action rather than straight at Better Auth's endpoint from
 * the form. A native HTML form sends `application/x-www-form-urlencoded`, and
 * the API deliberately refuses that content type on state-changing requests —
 * it is the exact shape a cross-origin CSRF form can produce. Going through the
 * action keeps every write JSON-only, which is the property that makes the
 * refusal safe to rely on.
 *
 * Until this succeeds there is NO session: Better Auth discards the pending one
 * and issues a challenge instead, so a stolen password alone gets nowhere.
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const code = String(form.get("code") ?? "").trim();
  const useBackupCode = form.get("mode") === "backup";

  const result = await call<{ status?: boolean }>(
    useBackupCode ? "/auth/two-factor/verify-backup" : "/auth/two-factor/verify",
    {
      method: "POST",
      request,
      body: { code, trustDevice: form.get("trustDevice") !== null },
    },
  );

  if (result.error) {
    return {
      // Deliberately identical for a wrong code and an expired one: telling
      // them apart would help someone grinding codes.
      error: "That code is not valid. Codes change every 30 seconds — try the current one.",
    };
  }

  // The verified challenge is exchanged for a real session cookie.
  return redirect("/app", { headers: withCookies(result) });
}

export default function TwoFactor() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  return (
    <>
      <AuthHeading title="Enter your code">
        Open your authenticator app and enter the six-digit code for Inkloom.
      </AuthHeading>

      {actionData?.error && (
        <div style={{ marginBottom: "1.25rem" }}>
          <Notice tone="critical">{actionData.error}</Notice>
        </div>
      )}

      <Form method="post" style={{ display: "grid", gap: "1.125rem" }}>
        <input type="hidden" name="mode" value="totp" />
        <Field
          label="Six-digit code"
          name="code"
          type="text"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          /* Lets the OS offer the code straight from an authenticator. */
          autoComplete="one-time-code"
          required
          autoFocus
          hint="The code changes every 30 seconds."
        />

        <label
          style={{
            display: "flex",
            gap: "0.625rem",
            alignItems: "center",
            fontSize: "var(--text-fine)",
            color: "var(--color-muted)",
          }}
        >
          <input type="checkbox" name="trustDevice" />
          <span>Trust this device for 60 days</span>
        </label>

        <button type="submit" className="btn btn-ink" disabled={submitting}>
          {submitting ? "Verifying…" : "Verify and sign in"}
        </button>
      </Form>

      <details style={{ marginTop: "1.75rem", fontSize: "var(--text-fine)" }}>
        <summary style={{ cursor: "pointer", color: "var(--color-muted)" }}>
          Lost your authenticator?
        </summary>
        <div style={{ marginTop: "0.875rem" }}>
          <p style={{ color: "var(--color-muted)", marginBottom: "0.75rem" }}>
            Use one of the backup codes you saved when you set up two-factor. Each one works once.
          </p>
          <Form method="post" style={{ display: "grid", gap: "0.75rem" }}>
            <input type="hidden" name="mode" value="backup" />
            <Field label="Backup code" name="code" type="text" required autoComplete="off" />
            <button type="submit" className="btn btn-quiet" disabled={submitting}>
              Use backup code
            </button>
          </Form>
          <p style={{ marginTop: "0.875rem", color: "var(--color-muted)" }}>
            No backup codes either? <Link to="/contact">Contact support</Link> — we will verify your
            identity another way.
          </p>
        </div>
      </details>
    </>
  );
}

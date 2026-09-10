import { Form, redirect, useActionData, useNavigation, useOutletContext } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/security";
import { call, fieldErrors, withCookies, type Me } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Field, Notice, PageHeader, Pill, formatCredits } from "../../components/ui";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Security",
    description: "Password, two-factor authentication and account deletion.",
    path: location.pathname,
    noindex: true,
  });
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "password") {
    const next = String(form.get("newPassword") ?? "");
    if (next !== String(form.get("confirmPassword") ?? "")) {
      return {
        intent,
        error: "Both new passwords need to match.",
        fields: {} as Record<string, string>,
        ok: false,
      };
    }

    const result = await call("/auth/change-password", {
      method: "POST",
      request,
      body: {
        currentPassword: String(form.get("currentPassword") ?? ""),
        newPassword: next,
        revokeOtherSessions: true,
      },
    });

    if (result.error) {
      return { intent, error: result.error.message, fields: fieldErrors(result.error), ok: false };
    }
    // The password change rotates the session, so forward the new cookie.
    return new Response(null, { status: 204, headers: withCookies(result) });
  }

  if (intent === "email") {
    const result = await call("/me/change-email", {
      method: "POST",
      request,
      body: {
        newEmail: String(form.get("newEmail") ?? ""),
        currentPassword: String(form.get("currentPassword") ?? ""),
      },
    });
    return result.error
      ? { intent, error: result.error.message, fields: fieldErrors(result.error), ok: false }
      : { intent, error: null, fields: {} as Record<string, string>, ok: true };
  }

  if (intent === "delete") {
    const result = await call("/me", {
      method: "DELETE",
      request,
      body: {
        currentPassword: String(form.get("currentPassword") ?? ""),
        confirmation: String(form.get("confirmation") ?? ""),
      },
    });

    if (result.error) {
      return { intent, error: result.error.message, fields: fieldErrors(result.error), ok: false };
    }
    // Session cookie is cleared by the API; forward that too.
    return redirect("/?deleted=1", { headers: withCookies(result) });
  }

  return { intent, error: "Unknown action.", fields: {} as Record<string, string>, ok: false };
}

export default function Security() {
  const { me } = useOutletContext<{ me: Me }>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const [confirmText, setConfirmText] = useState("");

  const forIntent = (intent: string) =>
    actionData && "intent" in actionData && actionData.intent === intent ? actionData : null;

  return (
    <>
      <PageHeader title="Security" description="Password, two-factor and account deletion." />

      <div style={{ display: "grid", gap: "3rem", maxWidth: "34rem" }}>
        {/* --- Two-factor -------------------------------------------------- */}
        <section>
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            <h2 style={{ fontSize: "var(--text-h4)" }}>Two-factor authentication</h2>
            <Pill tone={me.twoFactorEnabled ? "positive" : "neutral"}>
              {me.twoFactorEnabled ? "On" : "Off"}
            </Pill>
          </div>

          <p style={{ marginTop: "0.5rem", color: "var(--color-muted)" }}>
            A code from your authenticator app on top of your password. Someone with your password
            still cannot get in.
          </p>

          {me.role !== "user" && !me.twoFactorEnabled && (
            <div style={{ marginTop: "1rem" }}>
              <Notice tone="caution" title="Required for your account">
                Staff accounts must use two-factor authentication. Until you turn it on, admin pages
                will refuse your requests.
              </Notice>
            </div>
          )}

          {me.twoFactorEnabled ? (
            <Form
              method="post"
              action="/api/auth/two-factor/disable"
              style={{ marginTop: "1.25rem", display: "grid", gap: "0.875rem" }}
            >
              <Field
                label="Confirm your password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
              <div>
                <button type="submit" className="btn btn-quiet">
                  Turn off two-factor
                </button>
              </div>
            </Form>
          ) : (
            <Form
              method="post"
              action="/api/auth/two-factor/enable"
              style={{ marginTop: "1.25rem", display: "grid", gap: "0.875rem" }}
            >
              <Field
                label="Confirm your password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
              <input type="hidden" name="issuer" value="Inkloom" />
              <div>
                <button type="submit" className="btn btn-ink">
                  Set up two-factor
                </button>
              </div>
              <p className="field-hint">
                You will get a QR code and a set of backup codes. Save the backup codes somewhere
                safe — they are the only way in if you lose your phone.
              </p>
            </Form>
          )}
        </section>

        {/* --- Password ---------------------------------------------------- */}
        <section style={{ paddingTop: "2rem", borderTop: "1px solid var(--color-rule-soft)" }}>
          <h2 style={{ fontSize: "var(--text-h4)" }}>Change your password</h2>
          {forIntent("password")?.error && (
            <div style={{ marginTop: "1rem" }}>
              <Notice tone="critical">{forIntent("password")?.error}</Notice>
            </div>
          )}

          <Form method="post" style={{ display: "grid", gap: "1.125rem", marginTop: "1.25rem" }}>
            <input type="hidden" name="intent" value="password" />
            <Field
              label="Current password"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
            />
            <Field
              label="New password"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
              hint="At least 12 characters."
            />
            <Field
              label="Confirm new password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
            />
            <Notice tone="info">
              Changing your password signs out every other device and emails you a confirmation.
            </Notice>
            <div>
              <button type="submit" className="btn btn-ink" disabled={busy}>
                Change password
              </button>
            </div>
          </Form>
        </section>

        {/* --- Email ------------------------------------------------------- */}
        <section style={{ paddingTop: "2rem", borderTop: "1px solid var(--color-rule-soft)" }}>
          <h2 style={{ fontSize: "var(--text-h4)" }}>Change your email address</h2>
          {forIntent("email")?.ok && (
            <div style={{ marginTop: "1rem" }}>
              <Notice tone="positive" title="Check your current inbox">
                We sent a confirmation link to {me.email}. The change takes effect once you click
                it.
              </Notice>
            </div>
          )}
          {forIntent("email")?.error && (
            <div style={{ marginTop: "1rem" }}>
              <Notice tone="critical">{forIntent("email")?.error}</Notice>
            </div>
          )}

          <Form method="post" style={{ display: "grid", gap: "1.125rem", marginTop: "1.25rem" }}>
            <input type="hidden" name="intent" value="email" />
            <Field
              label="New email address"
              name="newEmail"
              type="email"
              autoComplete="email"
              required
            />
            <Field
              label="Confirm your password"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
            />
            <p className="field-hint">
              We send the confirmation to your CURRENT address, so a change cannot happen without
              access to the inbox you already use.
            </p>
            <div>
              <button type="submit" className="btn btn-ink" disabled={busy}>
                Send confirmation
              </button>
            </div>
          </Form>
        </section>

        {/* --- Delete ------------------------------------------------------ */}
        <section
          id="delete"
          style={{ paddingTop: "2rem", borderTop: "1px solid var(--color-critical)" }}
        >
          <h2 style={{ fontSize: "var(--text-h4)", color: "var(--color-critical)" }}>
            Delete your account
          </h2>
          <p style={{ marginTop: "0.5rem", color: "var(--color-muted)" }}>
            This cannot be undone. Your name, email and profile are removed, every session ends,
            pending email links stop working, and your {formatCredits(me.credits.balance)} in
            credits are forfeited.
          </p>

          {forIntent("delete")?.error && (
            <div style={{ marginTop: "1rem" }}>
              <Notice tone="critical">{forIntent("delete")?.error}</Notice>
            </div>
          )}

          <Form method="post" style={{ display: "grid", gap: "1.125rem", marginTop: "1.25rem" }}>
            <input type="hidden" name="intent" value="delete" />
            <Field
              label="Confirm your password"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
            />
            <Field
              label="Type DELETE MY ACCOUNT to confirm"
              name="confirmation"
              type="text"
              autoComplete="off"
              required
              // Uncontrolled for the same hydration reason; the state below only
              // gates the button, and the server re-checks the exact phrase.
              onChange={(event) => setConfirmText(event.target.value)}
            />
            <div>
              <button
                type="submit"
                className="btn btn-danger"
                /* The exact phrase is also required server-side; this only
                   stops the mis-click before it becomes a request. */
                disabled={busy || confirmText !== "DELETE MY ACCOUNT"}
              >
                Permanently delete my account
              </button>
            </div>
          </Form>
        </section>
      </div>
    </>
  );
}

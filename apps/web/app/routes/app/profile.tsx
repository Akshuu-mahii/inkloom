import { Form, redirect, useActionData, useNavigation, useOutletContext } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/profile";
import { call, fieldErrors, withCookies, type Me } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Field, Notice, PageHeader } from "../../components/ui";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Your profile",
    description: "Manage your Inkloom account details.",
    path: location.pathname,
    noindex: true,
  });
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "profile") {
    const result = await call("/me", {
      method: "PATCH",
      request,
      body: {
        name: String(form.get("name") ?? ""),
        company: String(form.get("company") ?? ""),
      },
    });
    return result.error
      ? { intent, error: result.error.message, fields: fieldErrors(result.error), ok: false }
      : { intent, error: null, fields: {} as Record<string, string>, ok: true };
  }

  if (intent === "preferences") {
    const result = await call("/me/notification-preferences", {
      method: "PATCH",
      request,
      body: {
        productUpdatesEmail: form.get("productUpdatesEmail") !== null,
        marketingEmail: form.get("marketingEmail") !== null,
        creditsEmail: form.get("creditsEmail") !== null,
      },
    });
    return result.error
      ? { intent, error: result.error.message, fields: {} as Record<string, string>, ok: false }
      : { intent, error: null, fields: {} as Record<string, string>, ok: true };
  }

  if (intent === "export") {
    const result = await call("/me/export", { method: "POST", request });
    return result.error
      ? { intent, error: result.error.message, fields: {} as Record<string, string>, ok: false }
      : { intent, error: null, fields: {} as Record<string, string>, ok: true };
  }

  /*
   * Erasing the account.
   *
   * On success the session is already gone — the API deletes every session row
   * and clears the cookie — so this redirects out of the dashboard rather than
   * re-rendering a page whose loader would now 401.
   */
  if (intent === "erase") {
    const result = await call("/me", {
      method: "DELETE",
      request,
      body: {
        currentPassword: String(form.get("currentPassword") ?? ""),
        understood: form.get("understood") !== null,
      },
    });

    if (result.error) {
      return { intent, error: result.error.message, fields: fieldErrors(result.error), ok: false };
    }
    return redirect("/?erased=1", { headers: withCookies(result) });
  }

  return { intent, error: "Unknown action.", fields: {} as Record<string, string>, ok: false };
}

export default function Profile() {
  const { me } = useOutletContext<{ me: Me }>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const saved = (intent: string) => actionData?.ok && actionData.intent === intent;
  const failed = (intent: string) =>
    actionData && !actionData.ok && actionData.intent === intent ? actionData.error : null;

  return (
    <>
      <PageHeader title="Profile" description="Your details and how we contact you." />

      <div style={{ display: "grid", gap: "3rem", maxWidth: "34rem" }}>
        {/* --- Details --------------------------------------------------- */}
        <section>
          <h2 style={{ fontSize: "var(--text-h4)" }}>Your details</h2>
          {saved("profile") && (
            <div style={{ marginTop: "1rem" }}>
              <Notice tone="positive">Profile saved.</Notice>
            </div>
          )}
          {failed("profile") && (
            <div style={{ marginTop: "1rem" }}>
              <Notice tone="critical">{failed("profile")}</Notice>
            </div>
          )}

          <Form method="post" style={{ display: "grid", gap: "1.125rem", marginTop: "1.25rem" }}>
            <input type="hidden" name="intent" value="profile" />
            <Field
              label="Display name"
              name="name"
              defaultValue={me.name}
              required
              maxLength={80}
              error={actionData?.fields?.name}
            />
            <Field
              label="Company"
              name="company"
              defaultValue={me.profile.company ?? ""}
              maxLength={120}
              hint="Optional."
            />
            <div>
              <span className="field-label">Email address</span>
              <p style={{ fontSize: "var(--text-base)" }}>{me.email}</p>
              <p className="field-hint">
                Changing your email needs your password and a confirmation from your current inbox.
                Do it from <a href="/app/security">Security</a>.
              </p>
            </div>
            <div>
              <button type="submit" className="btn btn-ink" disabled={busy}>
                Save changes
              </button>
            </div>
          </Form>
        </section>

        {/* --- Email preferences ------------------------------------------ */}
        <section style={{ paddingTop: "2rem", borderTop: "1px solid var(--color-rule-soft)" }}>
          <h2 style={{ fontSize: "var(--text-h4)" }}>Email preferences</h2>
          {saved("preferences") && (
            <div style={{ marginTop: "1rem" }}>
              <Notice tone="positive">Preferences saved.</Notice>
            </div>
          )}

          <Form method="post" style={{ display: "grid", gap: "0.875rem", marginTop: "1.25rem" }}>
            <input type="hidden" name="intent" value="preferences" />

            <Toggle
              name="productUpdatesEmail"
              defaultChecked={me.notificationPreferences.productUpdatesEmail}
              label="Product updates"
              description="Milestones, and the email that says generation is live."
            />
            <Toggle
              name="creditsEmail"
              defaultChecked={me.notificationPreferences.creditsEmail}
              label="Credit activity"
              description="When credits are added to your account."
            />
            <Toggle
              name="marketingEmail"
              defaultChecked={me.notificationPreferences.marketingEmail}
              label="Occasional marketing"
              description="Rare, and never sold or shared."
            />

            {/*
              Security email cannot be switched off, and a database CHECK pins it
              on regardless of what any form sends.

              Rendered as a real <label> wrapping a real disabled checkbox: an
              input with no label is invisible to a screen reader, and a
              lowered opacity on the whole row also dropped the text below the
              contrast threshold. The muted colour communicates "not editable"
              without making it unreadable.
            */}
            <label
              style={{
                display: "flex",
                gap: "0.75rem",
                alignItems: "flex-start",
                paddingTop: "0.25rem",
                cursor: "not-allowed",
              }}
            >
              <input
                type="checkbox"
                checked
                disabled
                aria-describedby="security-email-note"
                style={{ marginTop: "0.3rem" }}
              />
              <span>
                <span style={{ display: "block", fontWeight: 500, color: "var(--color-muted)" }}>
                  Security notices (always on)
                </span>
                <span
                  id="security-email-note"
                  style={{
                    display: "block",
                    fontSize: "var(--text-fine)",
                    color: "var(--color-muted)",
                  }}
                >
                  Password changes, new sign-ins and account changes. You need to know if someone
                  else is in your account, so this one cannot be turned off.
                </span>
              </span>
            </label>

            <div style={{ marginTop: "0.5rem" }}>
              <button type="submit" className="btn btn-ink" disabled={busy}>
                Save preferences
              </button>
            </div>
          </Form>
        </section>

        {/* --- Data ------------------------------------------------------- */}
        <section style={{ paddingTop: "2rem", borderTop: "1px solid var(--color-rule-soft)" }}>
          <h2 style={{ fontSize: "var(--text-h4)" }}>Your data</h2>
          <p style={{ marginTop: "0.5rem", color: "var(--color-muted)" }}>
            Download everything we hold about your account: profile, credit history, code
            redemptions, consents and sessions.
          </p>
          {saved("export") && (
            <div style={{ marginTop: "1rem" }}>
              <Notice tone="positive" title="Export ready">
                We have emailed you. The copy is deleted after 24 hours.
              </Notice>
            </div>
          )}
          <Form method="post" style={{ marginTop: "1.25rem" }}>
            <input type="hidden" name="intent" value="export" />
            <button type="submit" className="btn btn-quiet" disabled={busy}>
              Export my data
            </button>
          </Form>
        </section>

        {/* --- Erasure ------------------------------------------------------ */}
        <EraseAccount busy={busy} error={failed("erase")} fields={actionData?.fields} />
      </div>
    </>
  );
}

/**
 * Erasing the account, behind a deliberate second step.
 *
 * The confirmation is not decoration. This is the only action in the product
 * that cannot be undone, and it sits on the same page as "export my data" —
 * two buttons a tired person could confuse. The password field and the explicit
 * checkbox are what the API requires; the collapsed state is what stops the
 * form being one stray click away at all times.
 *
 * The copy says exactly what survives. Telling someone their data is "deleted"
 * when an immutable credit ledger keeps their entries under an opaque id would
 * be a promise the system cannot keep.
 */
function EraseAccount({
  busy,
  error,
  fields,
}: {
  busy: boolean;
  error: string | null;
  fields?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section
      style={{
        marginTop: "2rem",
        paddingTop: "2rem",
        borderTop: "1px solid var(--color-rule-soft)",
      }}
    >
      <h2 style={{ fontSize: "var(--text-h4)" }}>Erase this account</h2>
      <p style={{ marginTop: "0.5rem", color: "var(--color-muted)", maxWidth: "62ch" }}>
        This permanently removes your name, email address, profile and every way of signing in.
        It cannot be undone and we cannot recover the account afterwards.
      </p>
      <p style={{ marginTop: "0.5rem", color: "var(--color-muted)", maxWidth: "62ch" }}>
        Your credit history stays in our accounting records under an anonymous identifier, with
        nothing linking it to you. Consider exporting your data first.
      </p>

      {!open ? (
        <button
          type="button"
          className="btn btn-quiet"
          style={{ marginTop: "1.25rem" }}
          onClick={() => setOpen(true)}
        >
          Erase my account
        </button>
      ) : (
        <Form method="post" style={{ display: "grid", gap: "1rem", marginTop: "1.25rem" }}>
          <input type="hidden" name="intent" value="erase" />

          {error && (
            <Notice tone="critical" title="We could not erase your account">
              {error}
            </Notice>
          )}

          <Field
            label="Confirm your password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            error={fields?.currentPassword}
          />

          <label style={{ display: "flex", gap: "0.625rem", alignItems: "flex-start" }}>
            <input type="checkbox" name="understood" id="erase-understood" required />
            <span style={{ color: "var(--color-muted)" }}>
              I understand this permanently erases my account and cannot be undone.
            </span>
          </label>

          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <button type="submit" className="btn btn-danger" disabled={busy}>
              {busy ? "Erasing\u2026" : "Erase my account permanently"}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </Form>
      )}
    </section>
  );
}

function Toggle({
  name,
  label,
  description,
  defaultChecked,
}: {
  name: string;
  label: string;
  description: string;
  defaultChecked: boolean;
}) {
  return (
    <label style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start" }}>
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        style={{ marginTop: "0.3rem" }}
      />
      <span>
        <span style={{ display: "block", fontWeight: 500 }}>{label}</span>
        <span
          style={{ display: "block", fontSize: "var(--text-fine)", color: "var(--color-muted)" }}
        >
          {description}
        </span>
      </span>
    </label>
  );
}

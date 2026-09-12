import qrcode from "qrcode-generator";
import { Form, useActionData, useNavigation, useOutletContext } from "react-router";
import type { Route } from "./+types/security";
import { call, fieldErrors, withCookies, type Me } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Field, Notice, PageHeader, Pill } from "../../components/ui";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Security",
    description: "Password and two-factor authentication.",
    path: location.pathname,
    noindex: true,
  });
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  /*
   * Two-factor, in three steps.
   *
   * These forms used to post straight at /api/auth/two-factor/*. React Router
   * treats a `<Form action>` as a route to match, nothing serves /api/*, and
   * "Set up two-factor" landed on a 404 — so it could not be turned on at all.
   * Everything now goes through the API like every other action here.
   */
  if (intent === "2fa-start") {
    const result = await call<{ totpURI: string; backupCodes: string[] }>(
      "/auth/two-factor/enable",
      {
        method: "POST",
        request,
        body: { currentPassword: String(form.get("currentPassword") ?? "") },
      },
    );
    if (result.error || !result.data) {
      return {
        intent,
        error: result.error?.message ?? "Could not start setup.",
        fields: fieldErrors(result.error),
        ok: false,
        setup: null,
      };
    }

    /*
     * The QR is rendered here, on the server, from the otpauth URI.
     *
     * Not via a third-party image service: the URI contains the TOTP secret, so
     * handing it to `api.qrserver.com` or similar would be posting the second
     * factor to a stranger. `qrcode-generator` is a few KB of pure JavaScript
     * with no dependencies and no Node built-ins, so it runs in workerd.
     */
    const qr = qrcode(0, "M");
    qr.addData(result.data.totpURI);
    qr.make();

    return {
      intent,
      error: null,
      fields: {} as Record<string, string>,
      ok: true,
      setup: {
        /*
         * No `scalable`: that option drops the width/height attributes and
         * leaves only a viewBox, so the SVG collapsed to a 26px smudge inside
         * an inline-block parent. Explicit dimensions render at a size a phone
         * camera can actually read.
         */
        qrSvg: qr.createSvgTag({ cellSize: 5, margin: 1 }),
        // The manual-entry key, for anyone who cannot scan.
        secret: new URL(result.data.totpURI).searchParams.get("secret") ?? "",
        backupCodes: result.data.backupCodes,
      },
    };
  }

  if (intent === "2fa-confirm") {
    const result = await call("/auth/two-factor/confirm", {
      method: "POST",
      request,
      body: { code: String(form.get("code") ?? "") },
    });
    if (result.error) {
      return {
        intent,
        error: result.error.message,
        fields: fieldErrors(result.error),
        ok: false,
        setup: null,
      };
    }
    return new Response(null, { status: 204, headers: withCookies(result) });
  }

  if (intent === "2fa-disable") {
    const result = await call("/auth/two-factor/disable", {
      method: "POST",
      request,
      body: { currentPassword: String(form.get("currentPassword") ?? "") },
    });
    if (result.error) {
      return {
        intent,
        error: result.error.message,
        fields: fieldErrors(result.error),
        ok: false,
        setup: null,
      };
    }
    return new Response(null, { status: 204, headers: withCookies(result) });
  }

  if (intent === "set-password") {
    const next = String(form.get("newPassword") ?? "");
    if (next !== String(form.get("confirmPassword") ?? "")) {
      return {
        intent,
        error: "Both passwords need to match.",
        fields: {} as Record<string, string>,
        ok: false,
        setup: null,
      };
    }
    const result = await call("/auth/set-password", {
      method: "POST",
      request,
      body: { newPassword: next },
    });
    if (result.error) {
      return {
        intent,
        error: result.error.message,
        fields: fieldErrors(result.error),
        ok: false,
        setup: null,
      };
    }
    return new Response(null, { status: 204, headers: withCookies(result) });
  }

  if (intent === "password") {
    const next = String(form.get("newPassword") ?? "");
    if (next !== String(form.get("confirmPassword") ?? "")) {
      return {
        intent,
        error: "Both new passwords need to match.",
        fields: {} as Record<string, string>,
        ok: false,
        setup: null,
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
      return {
        intent,
        error: result.error.message,
        fields: fieldErrors(result.error),
        ok: false,
        setup: null,
      };
    }
    // The password change rotates the session, so forward the new cookie.
    return new Response(null, { status: 204, headers: withCookies(result) });
  }

  return {
    intent,
    error: "Unknown action.",
    fields: {} as Record<string, string>,
    ok: false,
    setup: null,
  };
}

export default function Security() {
  const { me } = useOutletContext<{ me: Me }>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const forIntent = (intent: string) =>
    actionData && "intent" in actionData && actionData.intent === intent ? actionData : null;

  /** Present only between starting setup and confirming it. */
  const setup = forIntent("2fa-start")?.setup ?? null;

  return (
    <>
      <PageHeader title="Security" description="Password, two-factor and your email address." />

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

          {/*
            Setup runs in two steps, because `skipVerificationOnEnable` is
            false: the first issues a secret, the second proves an authenticator
            actually accepts it. Doing it the other way round is how people lock
            themselves out of their own account.
          */}
          {/*
            Two-factor needs a password.

            Better Auth requires the password to enable TOTP, and an account
            created through Google has none — so this section could not work for
            them either. Rather than a form that fails, say what is missing.

            Worth knowing: a Google-only account is not unprotected meanwhile.
            The sign-in goes through Google, so whatever second factor is on the
            Google account already guards it. This adds one that is Inkloom's
            own, which matters once the account also has a password.
          */}
          {!me.hasPassword ? (
            <div style={{ marginTop: "1.25rem" }}>
              <Notice tone="info" title="Set a password first">
                Turning on two-factor here needs a password to confirm it is you, and this account
                signs in with Google instead. <a href="#password">Set a password</a> and this
                section becomes available. Until then your sign-in is protected by whatever
                two-factor your Google account uses.
              </Notice>
            </div>
          ) : setup ? (
            <div style={{ marginTop: "1.25rem", display: "grid", gap: "1.25rem" }}>
              <Notice tone="caution" title="Save your backup codes now">
                These are shown once. They are the only way in if you lose your phone.
              </Notice>

              <div>
                <p style={{ fontWeight: 600 }}>1. Scan this with your authenticator app</p>
                <div
                  style={{
                    marginTop: "0.625rem",
                    background: "#fff",
                    padding: "0.75rem",
                    display: "inline-block",
                    border: "1px solid var(--color-rule)",
                  }}
                  /* Generated on the server from the otpauth URI; the secret
                     never goes to a third-party QR service. */
                  dangerouslySetInnerHTML={{ __html: setup.qrSvg }}
                />
                <p className="field-hint" style={{ marginTop: "0.5rem" }}>
                  Can&rsquo;t scan? Enter this key by hand:{" "}
                  <code className="numeric">{setup.secret}</code>
                </p>
              </div>

              <div>
                <p style={{ fontWeight: 600 }}>2. Save these backup codes</p>
                <ul
                  className="numeric"
                  style={{
                    marginTop: "0.625rem",
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(9rem, 1fr))",
                    gap: "0.25rem 1rem",
                    listStyle: "none",
                    padding: 0,
                  }}
                >
                  {setup.backupCodes.map((code) => (
                    <li key={code}>{code}</li>
                  ))}
                </ul>
              </div>

              {forIntent("2fa-confirm")?.error && (
                <Notice tone="critical">{forIntent("2fa-confirm")?.error}</Notice>
              )}

              <Form method="post" style={{ display: "grid", gap: "0.875rem" }}>
                <input type="hidden" name="intent" value="2fa-confirm" />
                <Field
                  label="3. Enter the 6-digit code from the app"
                  name="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  error={forIntent("2fa-confirm")?.fields.code}
                />
                <div>
                  <button type="submit" className="btn btn-ink" disabled={busy}>
                    Turn on two-factor
                  </button>
                </div>
              </Form>
            </div>
          ) : me.twoFactorEnabled ? (
            <>
              {forIntent("2fa-disable")?.error && (
                <div style={{ marginTop: "1rem" }}>
                  <Notice tone="critical">{forIntent("2fa-disable")?.error}</Notice>
                </div>
              )}
              <Form
                method="post"
                style={{ marginTop: "1.25rem", display: "grid", gap: "0.875rem" }}
              >
                <input type="hidden" name="intent" value="2fa-disable" />
                <Field
                  label="Confirm your password"
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                  error={forIntent("2fa-disable")?.fields.currentPassword}
                />
                <div>
                  <button type="submit" className="btn btn-quiet" disabled={busy}>
                    Turn off two-factor
                  </button>
                </div>
              </Form>
            </>
          ) : (
            <>
              {forIntent("2fa-start")?.error && (
                <div style={{ marginTop: "1rem" }}>
                  <Notice tone="critical">{forIntent("2fa-start")?.error}</Notice>
                </div>
              )}
              <Form
                method="post"
                style={{ marginTop: "1.25rem", display: "grid", gap: "0.875rem" }}
              >
                <input type="hidden" name="intent" value="2fa-start" />
                <Field
                  label="Confirm your password"
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                  error={forIntent("2fa-start")?.fields.currentPassword}
                />
                <div>
                  <button type="submit" className="btn btn-ink" disabled={busy}>
                    Set up two-factor
                  </button>
                </div>
                <p className="field-hint">
                  You will get a QR code and a set of backup codes. Save the backup codes somewhere
                  safe — they are the only way in if you lose your phone.
                </p>
              </Form>
            </>
          )}
        </section>

        {/* --- Password ---------------------------------------------------- */}
        <section
          id="password"
          style={{ paddingTop: "2rem", borderTop: "1px solid var(--color-rule-soft)" }}
        >
          {me.hasPassword ? (
            <>
              <h2 style={{ fontSize: "var(--text-h4)" }}>Change your password</h2>
              {forIntent("password")?.error && (
                <div style={{ marginTop: "1rem" }}>
                  <Notice tone="critical">{forIntent("password")?.error}</Notice>
                </div>
              )}

              <Form
                method="post"
                style={{ display: "grid", gap: "1.125rem", marginTop: "1.25rem" }}
              >
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
                  minLength={6}
                  required
                  hint="At least 6 characters, including a letter, a number and a special character."
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
            </>
          ) : (
            <>
              {/*
                No password at all.

                Signing up through Google creates no credential, so there is
                nothing for a change-password form to confirm. Showing one would
                be showing a form that can only fail — and it is what silently
                disabled two-factor and email changes for these accounts too.
              */}
              <h2 style={{ fontSize: "var(--text-h4)" }}>Set a password</h2>
              <p style={{ marginTop: "0.5rem", color: "var(--color-muted)" }}>
                You signed in with Google, so this account has no password. Setting one lets you
                turn on two-factor and change your email address. Signing in with Google keeps
                working either way — this adds a second way in, it does not replace the first.
              </p>

              {forIntent("set-password")?.error && (
                <div style={{ marginTop: "1rem" }}>
                  <Notice tone="critical">{forIntent("set-password")?.error}</Notice>
                </div>
              )}

              <Form
                method="post"
                style={{ display: "grid", gap: "1.125rem", marginTop: "1.25rem" }}
              >
                <input type="hidden" name="intent" value="set-password" />
                <Field
                  label="New password"
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={6}
                  required
                  hint="At least 6 characters, including a letter, a number and a special character."
                />
                <Field
                  label="Confirm password"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                />
                <div>
                  <button type="submit" className="btn btn-ink" disabled={busy}>
                    Set password
                  </button>
                </div>
              </Form>
            </>
          )}
        </section>
      </div>
    </>
  );
}

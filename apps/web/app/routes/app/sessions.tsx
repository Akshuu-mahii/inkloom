import { Form, useActionData, useNavigation } from "react-router";
import type { Route } from "./+types/sessions";
import { call, type SessionSummary } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Notice, PageHeader, Pill, formatDate, formatRelative } from "../../components/ui";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Active sessions",
    description: "Devices signed in to your Inkloom account.",
    path: location.pathname,
    noindex: true,
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  const result = await call<{ sessions: SessionSummary[] }>("/me/sessions", { request });
  return { sessions: result.data?.sessions ?? [] };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "revoke-all") {
    const result = await call("/auth/logout-all", { method: "POST", request });
    if (result.error) return { error: result.error.message, revoked: null };
    // Revoking everything includes this session, so the user is signed out.
    return { error: null, revoked: "all" as const };
  }

  const sessionId = String(form.get("sessionId") ?? "");
  const result = await call<{ wasCurrent: boolean }>(`/me/sessions/${sessionId}`, {
    method: "DELETE",
    request,
  });

  if (result.error) return { error: result.error.message, revoked: null };
  return { error: null, revoked: "one" as const };
}

export default function Sessions({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const others = loaderData.sessions.filter((session) => !session.current);

  return (
    <>
      <PageHeader title="Sessions" description="Everywhere your account is currently signed in." />

      {actionData?.error && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="critical">{actionData.error}</Notice>
        </div>
      )}
      {actionData?.revoked === "one" && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="positive">That device has been signed out.</Notice>
        </div>
      )}

      <div style={{ marginBottom: "1.5rem" }}>
        <Notice tone="info">
          We show the browser and operating system so you can recognise your own devices. We do not
          show IP addresses or store a device fingerprint.
        </Notice>
      </div>

      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          borderTop: "1px solid var(--color-rule)",
        }}
      >
        {loaderData.sessions.map((session) => (
          <li
            key={session.id}
            style={{
              display: "flex",
              gap: "1rem",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              padding: "1.125rem 0",
              borderBottom: "1px solid var(--color-rule-soft)",
            }}
          >
            <div>
              <p
                style={{ fontWeight: 600, display: "flex", gap: "0.625rem", alignItems: "center" }}
              >
                {session.device}
                {session.current && <Pill tone="positive">This device</Pill>}
              </p>
              <p
                style={{
                  fontSize: "var(--text-fine)",
                  color: "var(--color-muted)",
                  marginTop: "0.25rem",
                }}
              >
                Active {formatRelative(session.lastActiveAt)} · Signed in{" "}
                {formatDate(session.createdAt)}
              </p>
            </div>

            {!session.current && (
              <Form method="post">
                <input type="hidden" name="sessionId" value={session.id} />
                <button type="submit" className="btn btn-quiet" disabled={busy}>
                  Sign out this device
                </button>
              </Form>
            )}
          </li>
        ))}
      </ul>

      {others.length > 0 && (
        <div
          style={{
            marginTop: "2.5rem",
            paddingTop: "1.5rem",
            borderTop: "1px solid var(--color-rule)",
          }}
        >
          <h2 style={{ fontSize: "var(--text-h4)" }}>Sign out everywhere</h2>
          <p style={{ marginTop: "0.5rem", color: "var(--color-muted)" }}>
            Ends every session including this one. Use this if you think someone else has access to
            your account — then change your password.
          </p>
          <Form method="post" style={{ marginTop: "1rem" }}>
            <input type="hidden" name="intent" value="revoke-all" />
            <button type="submit" className="btn btn-danger" disabled={busy}>
              Sign out of all devices
            </button>
          </Form>
        </div>
      )}
    </>
  );
}

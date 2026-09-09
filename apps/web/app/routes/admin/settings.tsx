import { Form, useActionData, useNavigation, useOutletContext } from "react-router";
import type { Route } from "./+types/settings";
import { call } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Field, Notice, PageHeader, Pill, TextArea } from "../../components/ui";
import { hasPermission, type Role } from "@inkloom/core/rbac";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Settings",
    description: "Feature flags and system settings.",
    path: location.pathname,
    noindex: true,
  });
}

interface SettingsResponse {
  flags: Array<{ key: string; enabled: boolean; description: string; highRisk: boolean }>;
  settings: Array<{ key: string; value: unknown; description: string; highRisk: boolean }>;
}

export async function loader({ request }: Route.LoaderArgs) {
  const result = await call<SettingsResponse>("/admin/settings", { request });
  return { data: result.data, error: result.error };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();

  // Only keys the form declares are sent; a client cannot invent a flag name,
  // and the API rejects any key not in the registry regardless.
  const flags: Record<string, boolean> = {};
  for (const key of form.getAll("flagKey")) {
    flags[String(key)] = form.get(`flag:${String(key)}`) !== null;
  }

  const result = await call("/admin/settings", {
    method: "PATCH",
    request,
    body: {
      flags,
      reason: String(form.get("reason") ?? ""),
      confirmation: String(form.get("confirmation") ?? ""),
    },
  });

  return result.error ? { error: result.error.message, ok: false } : { error: null, ok: true };
}

export default function AdminSettings({ loaderData }: Route.ComponentProps) {
  const { role } = useOutletContext<{ role: Role }>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const canWrite = hasPermission(role, "settings.write");
  const d = loaderData.data;

  if (!d) {
    return (
      <>
        <PageHeader title="Settings" />
        <Notice tone="critical">{loaderData.error?.message ?? "Could not load settings."}</Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Settings" description="Feature flags and operational limits." />

      {actionData?.ok && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="positive">Saved, and recorded in the audit log.</Notice>
        </div>
      )}
      {actionData?.error && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="critical">{actionData.error}</Notice>
        </div>
      )}

      {!canWrite && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="info">
            You can view settings. Changing them is reserved to a super admin.
          </Notice>
        </div>
      )}

      <Form method="post" style={{ maxWidth: "44rem" }}>
        <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1rem" }}>Feature flags</h2>

        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            borderTop: "1px solid var(--color-rule)",
          }}
        >
          {d.flags.map((flag) => {
            const isV2 = flag.key === "generation_enabled" || flag.key === "payments_enabled";
            return (
              <li
                key={flag.key}
                style={{
                  padding: "1rem 0",
                  borderBottom: "1px solid var(--color-rule-soft)",
                  display: "flex",
                  gap: "1rem",
                  alignItems: "flex-start",
                }}
              >
                <input type="hidden" name="flagKey" value={flag.key} />
                <input
                  type="checkbox"
                  name={`flag:${flag.key}`}
                  id={`flag-${flag.key}`}
                  defaultChecked={flag.enabled}
                  /* V2 flags are shown but not switchable: the functionality behind
                     them does not exist, so enabling one would expose a broken
                     surface rather than a feature. */
                  disabled={!canWrite || isV2}
                  style={{ marginTop: "0.3rem" }}
                />
                <div style={{ flex: 1 }}>
                  <label
                    htmlFor={`flag-${flag.key}`}
                    style={{
                      fontWeight: 600,
                      display: "flex",
                      gap: "0.5rem",
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      className="identifier"
                      style={{ color: "var(--color-ink)", fontSize: "var(--text-base)" }}
                    >
                      {flag.key}
                    </span>
                    {flag.highRisk && <Pill tone="critical">high risk</Pill>}
                    {isV2 && <Pill tone="neutral">not built yet</Pill>}
                  </label>
                  <p
                    style={{
                      fontSize: "var(--text-fine)",
                      color: "var(--color-muted)",
                      marginTop: "0.25rem",
                    }}
                  >
                    {flag.description}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>

        {canWrite && (
          <div style={{ display: "grid", gap: "1.125rem", marginTop: "2rem" }}>
            <TextArea
              label="Reason for this change"
              name="reason"
              required
              minLength={4}
              maxLength={500}
              style={{ minHeight: "4rem" }}
              hint="Recorded in the audit log against your name."
            />
            <Field
              label='Type "I UNDERSTAND" if you are changing a high-risk flag'
              name="confirmation"
              autoComplete="off"
              hint="Required for signup, redemption, promotional grants and the V2 flags."
            />
            <div>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={navigation.state === "submitting"}
              >
                Save settings
              </button>
            </div>
          </div>
        )}
      </Form>

      <section style={{ marginTop: "3rem", maxWidth: "44rem" }}>
        <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1rem" }}>System settings</h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Value</th>
                <th scope="col">Risk</th>
              </tr>
            </thead>
            <tbody>
              {d.settings.map((s) => (
                <tr key={s.key}>
                  <td>
                    <span className="identifier" style={{ color: "var(--color-ink)" }}>
                      {s.key}
                    </span>
                    <br />
                    <span style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
                      {s.description}
                    </span>
                  </td>
                  <td className="identifier" style={{ maxWidth: "22rem", wordBreak: "break-all" }}>
                    {JSON.stringify(s.value)}
                  </td>
                  <td>
                    {s.highRisk ? (
                      <Pill tone="critical">high</Pill>
                    ) : (
                      <Pill tone="neutral">normal</Pill>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ marginTop: "1rem", fontSize: "var(--text-fine)", color: "var(--color-muted)" }}>
          These are edited through the API with a validated JSON body, so a malformed value is
          rejected rather than stored. See docs/OPERATIONS.md.
        </p>
      </section>
    </>
  );
}

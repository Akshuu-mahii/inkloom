import { Form, useActionData, useNavigation, useOutletContext } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/system";
import { call } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Field, Notice, PageHeader, Pill, Stat, TextArea } from "../../components/ui";
import { hasPermission, type Role } from "@inkloom/core/rbac";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "System",
    description: "Platform health and emergency controls.",
    path: location.pathname,
    noindex: true,
  });
}

interface SystemInfo {
  environment: string;
  release: string;
  database: { reachable: boolean; latencyMs: number };
  email: { last24h: Array<{ status: string; count: number }>; transport: string };
  credits: { driftedWallets: number };
  integrations: { turnstile: boolean; sentry: boolean; googleOAuth: boolean };
}

export async function loader({ request }: Route.LoaderArgs) {
  const result = await call<SystemInfo>("/admin/system", { request });
  return { info: result.data, error: result.error };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const result = await call<{ action: string; affected: number }>("/admin/system/emergency", {
    method: "POST",
    request,
    body: {
      action: String(form.get("action") ?? ""),
      reason: String(form.get("reason") ?? ""),
      confirmation: String(form.get("confirmation") ?? ""),
    },
  });
  return result.error
    ? { error: result.error.message, result: null }
    : { error: null, result: result.data };
}

const EMERGENCY = [
  {
    action: "pause_signups",
    title: "Pause new registrations",
    body: "Existing users are unaffected. Use during a signup-abuse incident.",
    danger: false,
  },
  {
    action: "pause_redemption",
    title: "Pause code redemption",
    body: "Codes stop working immediately. Use if a code has leaked and you need time.",
    danger: false,
  },
  {
    action: "logout_all_users",
    title: "Sign out every user",
    body: "Ends every session on the platform, including yours. Use if session integrity is in doubt.",
    danger: true,
  },
  {
    action: "logout_all_admins",
    title: "Sign out every other admin",
    body: "Ends every staff session except your own, so you keep control while you investigate.",
    danger: true,
  },
] as const;

export default function AdminSystem({ loaderData }: Route.ComponentProps) {
  const { role } = useOutletContext<{ role: Role }>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [armed, setArmed] = useState<string | null>(null);
  const canEmergency = hasPermission(role, "system.emergency");
  const info = loaderData.info;

  return (
    <>
      <PageHeader title="System" description="Health, integrations and emergency controls." />

      {actionData?.result && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="positive" title="Emergency control applied">
            {actionData.result.action.replace(/_/g, " ")} — {actionData.result.affected} session(s)
            affected. Recorded as a critical security event.
          </Notice>
        </div>
      )}
      {actionData?.error && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="critical">{actionData.error}</Notice>
        </div>
      )}

      {info ? (
        <>
          <section
            style={{
              display: "grid",
              gap: "1.5rem",
              gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
              paddingBottom: "2rem",
              borderBottom: "1px solid var(--color-rule-soft)",
            }}
          >
            <Stat value={info.environment} label="Environment" />
            <Stat
              value={`${info.database.latencyMs} ms`}
              label="Database latency"
              tone={info.database.latencyMs > 500 ? "loop" : "ink"}
            />
            <Stat
              value={info.credits.driftedWallets}
              label="Drifted wallets"
              tone={info.credits.driftedWallets > 0 ? "loop" : "muted"}
              hint={
                info.credits.driftedWallets > 0 ? "Investigate immediately" : "Ledger reconciles"
              }
            />
            <Stat value={info.email.transport} label="Email transport" />
          </section>

          <section style={{ marginTop: "2.5rem" }}>
            <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1rem" }}>
              Email delivery (24h)
            </h2>
            {info.email.last24h.length === 0 ? (
              <p style={{ color: "var(--color-muted)" }}>Nothing sent in the last day.</p>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "grid",
                  gap: "0.375rem",
                  maxWidth: "24rem",
                }}
              >
                {info.email.last24h.map((row) => (
                  <li
                    key={row.status}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "0.5rem 0",
                      borderBottom: "1px solid var(--color-rule-soft)",
                      fontSize: "var(--text-fine)",
                    }}
                  >
                    <Pill
                      tone={
                        row.status === "sent" || row.status === "delivered"
                          ? "positive"
                          : row.status === "queued"
                            ? "neutral"
                            : "critical"
                      }
                    >
                      {row.status}
                    </Pill>
                    <span className="numeric">{row.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={{ marginTop: "2.5rem" }}>
            <h2 style={{ fontSize: "var(--text-h4)", marginBottom: "1rem" }}>Integrations</h2>
            <ul
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "grid",
                gap: "0.375rem",
                maxWidth: "24rem",
              }}
            >
              {[
                ["Turnstile", info.integrations.turnstile],
                ["Sentry", info.integrations.sentry],
                ["Google OAuth", info.integrations.googleOAuth],
              ].map(([label, on]) => (
                <li
                  key={String(label)}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "0.5rem 0",
                    borderBottom: "1px solid var(--color-rule-soft)",
                    fontSize: "var(--text-fine)",
                  }}
                >
                  <span>{String(label)}</span>
                  <Pill tone={on ? "positive" : "neutral"}>
                    {on ? "configured" : "not configured"}
                  </Pill>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : (
        <Notice tone="critical">
          {loaderData.error?.message ?? "Could not load system information."}
        </Notice>
      )}

      {/* --- Emergency controls ------------------------------------------ */}
      <section style={{ marginTop: "3rem", maxWidth: "40rem" }}>
        <h2 style={{ fontSize: "var(--text-h4)" }}>Emergency controls</h2>
        <p style={{ marginTop: "0.5rem", color: "var(--color-muted)" }}>
          Each of these takes effect immediately across the whole platform. Every one needs a reason
          and an exact typed confirmation, and is recorded as a critical security event.
        </p>

        {!canEmergency ? (
          <div style={{ marginTop: "1.25rem" }}>
            <Notice tone="info">Emergency controls are reserved to a super admin.</Notice>
          </div>
        ) : (
          <div style={{ display: "grid", gap: "1rem", marginTop: "1.5rem" }}>
            {EMERGENCY.map((control) => (
              <div
                key={control.action}
                style={{
                  border: `1px solid ${control.danger ? "var(--color-critical)" : "var(--color-rule)"}`,
                  padding: "1.25rem",
                }}
              >
                <h3
                  style={{
                    fontSize: "var(--text-lead)",
                    fontFamily: "var(--font-sans)",
                    letterSpacing: 0,
                  }}
                >
                  {control.title}
                </h3>
                <p
                  style={{
                    marginTop: "0.375rem",
                    fontSize: "var(--text-fine)",
                    color: "var(--color-muted)",
                  }}
                >
                  {control.body}
                </p>

                {armed === control.action ? (
                  <Form
                    method="post"
                    style={{ display: "grid", gap: "0.875rem", marginTop: "1rem" }}
                  >
                    <input type="hidden" name="action" value={control.action} />
                    <TextArea
                      label="Reason"
                      name="reason"
                      required
                      minLength={4}
                      maxLength={500}
                      style={{ minHeight: "3.5rem" }}
                    />
                    <Field
                      label={`Type "${control.action}" to confirm`}
                      name="confirmation"
                      required
                      autoComplete="off"
                      style={{ fontFamily: "var(--font-mono)" }}
                    />
                    <div style={{ display: "flex", gap: "0.625rem" }}>
                      <button
                        type="submit"
                        className={control.danger ? "btn btn-danger" : "btn btn-ink"}
                        disabled={navigation.state === "submitting"}
                      >
                        {navigation.state === "submitting" ? "Applying…" : "Confirm"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-quiet"
                        onClick={() => setArmed(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </Form>
                ) : (
                  <button
                    type="button"
                    className={control.danger ? "btn btn-danger" : "btn btn-quiet"}
                    style={{ marginTop: "1rem" }}
                    /* Two deliberate steps: arming reveals the form, and the form
                       still demands the action name typed out in full. */
                    onClick={() => setArmed(control.action)}
                  >
                    {control.title}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

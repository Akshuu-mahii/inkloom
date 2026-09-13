import { Form, Link, useActionData, useNavigation } from "react-router";
import { adminUrl, useAdminPath } from "./admin-path";
import { useState } from "react";
import type { Route } from "./+types/campaign-new";
import { call, fieldErrors } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Field, Notice, PageHeader, TextArea } from "../../components/ui";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "New campaign",
    description: "Create a code campaign.",
    path: location.pathname,
    noindex: true,
  });
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();

  const domains = String(form.get("allowedEmailDomains") ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  const result = await call<{
    id: string;
    name: string;
    code: string;
    codeMasked: string;
    creditAmount: number;
  }>("/admin/access-codes", {
    method: "POST",
    request,
    body: {
      name: String(form.get("name") ?? ""),
      description: String(form.get("description") ?? "") || undefined,
      code: String(form.get("code") ?? "") || undefined,
      creditAmount: Number(form.get("creditAmount") ?? 0),
      maxTotalRedemptions: form.get("maxTotalRedemptions")
        ? Number(form.get("maxTotalRedemptions"))
        : null,
      maxRedemptionsPerUser: Number(form.get("maxRedemptionsPerUser") ?? 1),
      expiresAt: form.get("expiresAt")
        ? new Date(String(form.get("expiresAt"))).toISOString()
        : null,
      allowedEmailDomains: domains.length ? domains : null,
      targetCohort: String(form.get("targetCohort") ?? "") || null,
      reason: String(form.get("reason") ?? ""),
    },
  });

  return result.error
    ? { error: result.error, fields: fieldErrors(result.error), created: null }
    : { error: null, fields: {} as Record<string, string>, created: result.data };
}

export default function NewCampaign() {
  const adminPath = useAdminPath();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [copied, setCopied] = useState(false);

  /**
   * The one and only reveal.
   *
   * Only the HMAC fingerprint is stored, so this screen is the single moment
   * the plaintext exists outside the creator's head. The UI says so plainly
   * rather than letting an admin assume they can look it up later.
   */
  if (actionData?.created) {
    const created = actionData.created;
    return (
      <>
        <PageHeader title="Campaign created" description={created.name} />

        <div style={{ maxWidth: "34rem" }}>
          <Notice tone="caution" title="Copy this code now — it will never be shown again">
            Inkloom stores only a keyed hash of the code. Nobody, including you, can recover it from
            the database. If you lose it, revoke the campaign and create another.
          </Notice>

          <div
            style={{
              marginTop: "1.5rem",
              border: "1px solid var(--color-ink)",
              padding: "1.5rem",
              background: "var(--color-panel)",
            }}
          >
            <p
              className="identifier"
              style={{
                fontSize: "var(--text-h3)",
                color: "var(--color-ink)",
                letterSpacing: "0.06em",
                wordBreak: "break-all",
              }}
            >
              {created.code}
            </p>
            <button
              type="button"
              className="btn btn-quiet"
              style={{ marginTop: "1rem" }}
              onClick={() => {
                void navigator.clipboard?.writeText(created.code).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy code"}
            </button>
          </div>

          <dl
            style={{
              marginTop: "1.5rem",
              display: "grid",
              gap: "0.5rem",
              fontSize: "var(--text-fine)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <dt style={{ color: "var(--color-muted)" }}>Credits per redemption</dt>
              <dd className="numeric" style={{ margin: 0 }}>
                {created.creditAmount}
              </dd>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <dt style={{ color: "var(--color-muted)" }}>Stored as</dt>
              <dd className="identifier" style={{ margin: 0 }}>
                {created.codeMasked}
              </dd>
            </div>
          </dl>

          <div style={{ display: "flex", gap: "0.75rem", marginTop: "2rem" }}>
            <Link to={adminUrl(adminPath, `access-codes/${created.id}`)} className="btn btn-ink">
              View campaign
            </Link>
            <Link to={adminUrl(adminPath, "access-codes")} className="btn btn-quiet">
              All campaigns
            </Link>
          </div>
        </div>
      </>
    );
  }

  const fields = actionData?.fields ?? {};

  return (
    <>
      <PageHeader
        title="Create a campaign"
        description="A campaign turns one code into credits, with limits you control."
        actions={
          <Link to={adminUrl(adminPath, "access-codes")} className="btn btn-quiet">
            Cancel
          </Link>
        }
      />

      {actionData?.error && (
        <div style={{ marginBottom: "1.5rem", maxWidth: "34rem" }}>
          <Notice tone="critical" title="Could not create the campaign">
            {actionData.error.message}
          </Notice>
        </div>
      )}

      <Form method="post" style={{ display: "grid", gap: "1.125rem", maxWidth: "34rem" }}>
        <Field
          label="Campaign name"
          name="name"
          required
          minLength={2}
          maxLength={120}
          error={fields.name}
          hint="Shown to users when they redeem, and in their credit history."
        />

        <TextArea
          label="Internal description"
          name="description"
          maxLength={500}
          style={{ minHeight: "4.5rem" }}
          hint="Staff only. Never shown to users."
        />

        <Field
          label="Code"
          name="code"
          maxLength={128}
          autoComplete="off"
          spellCheck={false}
          style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.05em" }}
          hint="Leave blank to generate a strong random code. Letters and digits only; hyphens and spaces are ignored when redeeming."
          error={fields.code}
        />

        <Field
          label="Credits per redemption"
          name="creditAmount"
          type="number"
          min={1}
          max={1000000}
          required
          defaultValue={500}
          error={fields.creditAmount}
        />

        <div style={{ display: "grid", gap: "1.125rem", gridTemplateColumns: "1fr 1fr" }}>
          <Field
            label="Maximum total redemptions"
            name="maxTotalRedemptions"
            type="number"
            min={1}
            hint="Blank means unlimited."
          />
          <Field
            label="Per user"
            name="maxRedemptionsPerUser"
            type="number"
            min={1}
            max={100}
            defaultValue={1}
            hint="Normally 1."
          />
        </div>

        <Field label="Expires" name="expiresAt" type="date" hint="Blank means it never expires." />

        <Field
          label="Restrict to email domains"
          name="allowedEmailDomains"
          maxLength={500}
          hint="Comma-separated, e.g. mitwpu.edu.in. Blank means any verified address."
        />

        <Field
          label="Cohort tag"
          name="targetCohort"
          maxLength={100}
          hint="For reporting, e.g. hackathon-2026."
        />

        <TextArea
          label="Reason for creating this campaign"
          name="reason"
          required
          minLength={4}
          maxLength={500}
          style={{ minHeight: "4.5rem" }}
          hint="Recorded in the audit log against your name."
          error={fields.reason}
        />

        <div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={navigation.state === "submitting"}
          >
            {navigation.state === "submitting" ? "Creating…" : "Create campaign"}
          </button>
        </div>
      </Form>
    </>
  );
}

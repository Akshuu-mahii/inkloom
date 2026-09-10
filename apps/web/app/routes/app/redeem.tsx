import { Form, useActionData, useNavigation, useOutletContext } from "react-router";
import type { Route } from "./+types/redeem";
import { call, type Me } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { Field, Notice, PageHeader, formatCredits } from "../../components/ui";
import { track } from "../../lib/analytics";
import { useEffect } from "react";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Redeem an access code",
    description: "Redeem an Inkloom early-access code.",
    path: location.pathname,
    noindex: true,
  });
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();

  const result = await call<{
    creditsGranted: number;
    balance: number;
    campaignName: string;
    alreadyRedeemed: boolean;
  }>("/access-codes/redeem", {
    method: "POST",
    request,
    body: {
      code: String(form.get("code") ?? ""),
      /**
       * No client-supplied idempotency key.
       *
       * An earlier version derived one from `useId`, which was wrong: the id is
       * stable for the life of the page, so redeeming code A and then code B
       * without a reload would send BOTH under the same key and replay the first
       * result for the second code.
       *
       * The server generates a fresh key per request instead, and correctness
       * comes from the database: the unique index on
       * (campaign, user, slot) means concurrent or repeated submissions can only
       * ever produce one redemption, and the loser is answered with the winner's
       * result rather than an error. That is proven by the concurrency test,
       * which fires 25 simultaneous redemptions with DISTINCT keys and asserts
       * exactly one grant.
       */
    },
  });

  if (result.error) return { error: result.error, success: null };
  return { error: null, success: result.data };
}

export default function Redeem() {
  const { me } = useOutletContext<{ me: Me }>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  // Only a genuine, non-replayed grant counts as a redemption in the funnel.
  useEffect(() => {
    if (actionData?.success && !actionData.success.alreadyRedeemed) {
      track("access_code_redeemed", { credits: actionData.success.creditsGranted });
    }
  }, [actionData]);

  if (!me.emailVerified) {
    return (
      <>
        <PageHeader title="Redeem an access code" />
        <Notice tone="caution" title="Confirm your email first">
          Access codes can only be redeemed on a verified account. Check your inbox for the
          confirmation link.
        </Notice>
      </>
    );
  }

  if (!me.platform.redemptionEnabled) {
    return (
      <>
        <PageHeader title="Redeem an access code" />
        <Notice tone="caution" title="Redemption is paused">
          Code redemption is temporarily unavailable. Your code will still work once it is back —
          nothing expires in the meantime.
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Redeem an access code"
        description="Enter the code you were given. Case, spaces and hyphens do not matter."
      />

      {actionData?.success && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice
            tone="positive"
            title={
              actionData.success.alreadyRedeemed
                ? "You have already redeemed this code"
                : `${formatCredits(actionData.success.creditsGranted)} in credits added`
            }
          >
            {actionData.success.alreadyRedeemed ? (
              <>Your balance is {formatCredits(actionData.success.balance)}.</>
            ) : (
              <>
                {actionData.success.campaignName} — your balance is now{" "}
                <strong>{formatCredits(actionData.success.balance)}</strong> in credits.
              </>
            )}
          </Notice>
        </div>
      )}

      {actionData?.error && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Notice tone="critical" title="Could not redeem that code">
            {actionData.error.message}
          </Notice>
        </div>
      )}

      <Form
        method="post"
        style={{ display: "grid", gap: "1.125rem", maxWidth: "26rem" }}
        onSubmit={() => track("access_code_attempted")}
      >
        <Field
          label="Access code"
          name="code"
          type="text"
          required
          autoFocus
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          placeholder="INKLOOM-HACKATHON"
          style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.05em" }}
          hint="Codes are not case-sensitive."
        />
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Redeeming…" : "Redeem code"}
        </button>
      </Form>

      <div style={{ marginTop: "2.5rem", maxWidth: "34rem" }}>
        <h2 style={{ fontSize: "var(--text-h4)" }}>About early-access credits</h2>
        <ul
          style={{
            marginTop: "0.875rem",
            paddingLeft: "1.125rem",
            color: "var(--color-muted)",
            display: "grid",
            gap: "0.5rem",
          }}
        >
          <li>They are promotional and cost nothing.</li>
          <li>They do not expire.</li>
          <li>They become usable when logo generation opens — nothing spends them today.</li>
          <li>Each code can normally be redeemed once per account.</li>
        </ul>
      </div>
    </>
  );
}

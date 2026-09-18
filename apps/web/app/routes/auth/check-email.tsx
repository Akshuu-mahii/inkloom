import { useEffect } from "react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
  useRevalidator,
  useSearchParams,
} from "react-router";
import type { Route } from "./+types/check-email";
import { AuthHeading } from "./layout";
import { Notice } from "../../components/ui";
import { call } from "../../lib/api";
import { buildMeta } from "../../lib/seo";
import { BusyLabel } from "../../components/infinity-mark";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Check your email",
    description: "Confirm your email address to finish setting up your Inkloom account.",
    path: location.pathname,
    noindex: true,
  });
}

/**
 * Notice when the address has already been confirmed somewhere else.
 *
 * This page had no loader at all: it rendered "confirm your email" from the
 * `?to=` query parameter and nothing more. So confirming the link on a phone,
 * or in a second tab, left the original tab saying "check your email" forever —
 * and refreshing it changed nothing, because there was nothing to re-run. The
 * account was live and the page insisted it was not, which reads as the product
 * being broken rather than the tab being stale.
 *
 * Verification signs the visitor in, and a cookie is shared across tabs of the
 * same browser. So this simply asks who the caller is: if they are verified,
 * they are finished here and belong on the dashboard.
 *
 * `?welcome=1` so the dashboard shows the confirmation banner, exactly as the
 * tab that did the verifying does.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const result = await call<{ emailVerified: boolean }>("/me", { request });

  if (result.data?.emailVerified) throw redirect("/app?welcome=1");

  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  // The response is identical for a known and an unknown address, so nothing
  // here can be used to test whether an account exists.
  await call("/auth/resend-verification", {
    method: "POST",
    request,
    body: { email: String(form.get("email") ?? "") },
  });
  return { resent: true };
}

export default function CheckEmail() {
  const [params] = useSearchParams();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const email = params.get("to") ?? "";

  /*
   * Re-check when the tab is looked at again.
   *
   * The common shape of this is two tabs, or a laptop and a phone: the link is
   * opened elsewhere and this tab is simply switched back to. Without this it
   * keeps its stale render until something forces a navigation, so the fix
   * above would only work for people who thought to press refresh.
   *
   * Focus and visibility rather than an interval: it costs nothing while the
   * tab sits in the background, and the moment somebody actually looks at it
   * the loader runs and redirects.
   */
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") {
        revalidator.revalidate();
      }
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [revalidator]);

  return (
    <>
      <AuthHeading title="Confirm your email">
        {email ? (
          <>
            If <strong style={{ color: "var(--color-ink)" }}>{email}</strong> needs an email from
            us, it is on its way. Open it and click the link to finish.
          </>
        ) : (
          "If that address needs an email from us, it is on its way. Open it and click the link to finish."
        )}
      </AuthHeading>

      <Notice tone="info" title="The link expires in 24 hours">
        It can only be used once. If it expires, request a new one below and any earlier link stops
        working.
      </Notice>

      {actionData?.resent && (
        <div style={{ marginTop: "1rem" }}>
          <Notice tone="positive">
            Sent. Check your inbox, and your spam folder if it is not there in a minute.
          </Notice>
        </div>
      )}

      <Form method="post" style={{ marginTop: "1.75rem" }}>
        <input type="hidden" name="email" value={email} />
        <button
          type="submit"
          className="btn btn-quiet"
          disabled={navigation.state === "submitting"}
          style={{ width: "100%" }}
        >
          {navigation.state === "submitting" ? (
            <BusyLabel>Sending…</BusyLabel>
          ) : (
            "Send the email again"
          )}
        </button>
      </Form>

      <p style={{ marginTop: "1.5rem", fontSize: "var(--text-fine)", color: "var(--color-muted)" }}>
        Wrong address? <Link to="/auth/signup">Start again</Link> · Already confirmed?{" "}
        <Link to="/auth/login">Sign in</Link>
      </p>
    </>
  );
}

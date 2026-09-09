import { Link, redirect } from "react-router";
import type { Route } from "./+types/verify-email";
import { AuthHeading } from "./layout";
import { Notice } from "../../components/ui";
import { call, withCookies } from "../../lib/api";
import { buildMeta } from "../../lib/seo";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Verifying your email",
    description: "Confirming your Inkloom email address.",
    path: location.pathname,
    noindex: true,
  });
}

/**
 * Verification happens in the LOADER, not an action.
 *
 * The link in the email is a plain GET that a person clicks from their inbox,
 * so the work has to happen on navigation. That is acceptable here precisely
 * because the token is single-purpose, expiring and carried in the URL — it is
 * not a state-changing request an attacker can forge from another origin, since
 * they would need the token itself.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const token = new URL(request.url).searchParams.get("token");

  if (!token) {
    return { ok: false as const, reason: "missing" as const };
  }

  const result = await call<{ redirectTo?: string }>("/auth/verify-email", {
    method: "POST",
    request,
    body: { token },
  });

  if (result.error) {
    return { ok: false as const, reason: "invalid" as const };
  }

  // Better Auth signs the user in on verification, so forward the session
  // cookie and land them straight on the dashboard.
  return redirect("/app?welcome=1", { headers: withCookies(result) });
}

export default function VerifyEmail({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <AuthHeading title="That link did not work">
        {loaderData.reason === "missing"
          ? "This page needs a confirmation link from your email."
          : "This link is invalid or has expired."}
      </AuthHeading>

      <Notice tone="caution" title="Confirmation links are single-use and expire">
        Request a fresh one and it will arrive within a minute.
      </Notice>

      <div style={{ display: "grid", gap: "0.75rem", marginTop: "1.75rem" }}>
        <Link to="/auth/check-email" className="btn btn-ink">
          Send a new link
        </Link>
        <Link to="/auth/login" className="btn btn-quiet">
          Back to sign in
        </Link>
      </div>
    </>
  );
}

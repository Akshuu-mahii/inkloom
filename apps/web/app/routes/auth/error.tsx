import { Link, useSearchParams } from "react-router";
import type { Route } from "./+types/error";
import { AuthHeading } from "./layout";
import { Notice } from "../../components/ui";
import { buildMeta } from "../../lib/seo";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Sign-in problem",
    description: "Something went wrong while signing you in.",
    path: location.pathname,
    noindex: true,
  });
}

/**
 * Where a failed OAuth or callback flow lands.
 *
 * The `error` parameter is a code from the provider, so it is matched against a
 * KNOWN LIST and never rendered back to the page. Reflecting an arbitrary query
 * parameter into the DOM is how a reflected-XSS bug starts.
 */
const MESSAGES: Record<string, { title: string; body: string }> = {
  access_denied: {
    title: "Sign-in was cancelled",
    body: "You declined the permission request, so nothing was shared with Inkloom.",
  },
  account_not_linked: {
    title: "That address is already registered",
    body: "An Inkloom account already uses this email with a password. Sign in that way, then link the provider from your profile.",
  },
  unable_to_create_user: {
    title: "We could not create your account",
    body: "Something went wrong on our end. Trying again usually works.",
  },
  invalid_token: {
    title: "That link has expired",
    body: "Sign-in links are single-use and short-lived. Request a fresh one.",
  },
};

const FALLBACK = {
  title: "Something went wrong signing you in",
  body: "We could not complete sign-in. Trying again usually works; if it keeps happening, contact support.",
};

export default function AuthError() {
  const [params] = useSearchParams();
  const code = params.get("error") ?? "";
  // Allowlisted lookup only — the raw parameter is never rendered.
  const message = MESSAGES[code] ?? FALLBACK;

  return (
    <>
      <AuthHeading title={message.title} />
      <Notice tone="critical">{message.body}</Notice>
      <div style={{ display: "grid", gap: "0.75rem", marginTop: "1.75rem" }}>
        <Link to="/auth/login" className="btn btn-ink">
          Back to sign in
        </Link>
        <Link to="/contact" className="btn btn-quiet">
          Contact support
        </Link>
      </div>
    </>
  );
}

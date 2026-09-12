/**
 * Start the Google sign-in flow.
 *
 * The two buttons used to be `<a href="/api/auth/sign-in/social?...">`. That
 * could never have worked: Better Auth's social sign-in is a POST that answers
 * with `{ url }` for the browser to follow, so a GET at that path was not a
 * route at all and returned 404. The third control in this app pointed straight
 * at the API in a way the API does not accept.
 *
 * So the button posts here, this asks Better Auth where to send the person, and
 * we redirect them there. Posting also means the flow cannot be started by a
 * cross-site `<img>` or a link prefetch, which a GET would allow.
 *
 * Nothing is mutated until Google redirects back to
 * `/api/auth/callback/google` with a code; that callback is Better Auth's own.
 */
import { redirect } from "react-router";
import type { Route } from "./+types/google";

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();

  /*
   * Where to land afterwards, taken from the form and never trusted as given.
   *
   * An attacker-supplied `callbackURL` is how an OAuth start becomes an open
   * redirect, so anything that is not a site-relative path — including a
   * protocol-relative `//evil.com` — is replaced with the default.
   */
  const requested = String(form.get("next") ?? "/app");
  const callbackURL = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/app";

  const origin = new URL(request.url).origin;

  /*
   * A direct fetch rather than the `call()` helper, for two reasons.
   *
   * Better Auth is not Inkloom's API: it answers with a bare `{ url }`, not the
   * `{ data, error }` envelope `call()` unwraps, so `call()` read the payload as
   * empty and sent everyone to the error page.
   *
   * And this response carries Set-Cookie. Better Auth stores the OAuth `state`
   * and PKCE verifier there, and the callback validates them. Dropping those
   * headers would make the flow fail at the very last step, after Google had
   * already been visited — so they are forwarded verbatim onto the redirect.
   */
  const response = await fetch(`${origin}/api/auth/sign-in/social`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      // The API enforces a strict same-origin check on writes; a server-side
      // call has no browser Origin header, so it supplies its own.
      origin,
      ...(request.headers.get("cookie") ? { cookie: request.headers.get("cookie")! } : {}),
      // So the session this eventually creates records a real device, not
      // "Unknown browser on Unknown OS".
      ...(request.headers.get("user-agent")
        ? { "user-agent": request.headers.get("user-agent")! }
        : {}),
      // So this request lands in the caller's own rate-limit bucket, not a
      // shared one. See the note in lib/api.ts.
      ...(request.headers.get("cf-connecting-ip")
        ? { "cf-connecting-ip": request.headers.get("cf-connecting-ip")! }
        : {}),
    },
    body: JSON.stringify({ provider: "google", callbackURL }),
  }).catch(() => null);

  const payload = (await response?.json().catch(() => null)) as { url?: string } | null;

  if (!response?.ok || !payload?.url) {
    // Misconfigured credentials or an unreachable Google are not something to
    // show raw; the sign-in page explains it in words.
    return redirect("/auth/login?error=google");
  }

  const headers = new Headers({ Location: payload.url });
  for (const cookie of response.headers.getSetCookie?.() ?? []) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 303, headers });
}

/** Nothing to render: a GET here just goes back to sign-in. */
export async function loader() {
  return redirect("/auth/login");
}

/**
 * Sign out.
 *
 * This exists because the header used to post a form STRAIGHT at
 * `/api/v1/auth/logout`. That worked — the session really was ended — but a
 * native form post navigates to whatever the target returns, so the browser
 * landed on the API's JSON envelope. You were signed out and staring at
 * `{"data":{"success":true},...}` on a blank page.
 *
 * Posting here instead keeps the good property of the old approach and drops
 * the bad one. It is still an ordinary form post, so it works with JavaScript
 * disabled and needs no client-side handler; but this is a React Router action,
 * so it can forward the session-clearing cookie AND answer with a redirect to a
 * real page.
 *
 * There is no component. A GET lands here only if someone types the URL, and
 * signing out on a GET would let any page log you out with an <img> tag — so a
 * GET redirects away without touching the session.
 */
import { redirect } from "react-router";
import type { Route } from "./+types/sign-out";
import { call, withCookies } from "../../lib/api";

export async function action({ request }: Route.ActionArgs) {
  const result = await call("/auth/logout", { method: "POST", request });

  /*
   * Redirect regardless of what the API said.
   *
   * A failed logout is nearly always a session that was already gone — expired,
   * revoked from another device, or cleared by an emergency logout. Showing an
   * error for that would be alarming and useless: the person asked to be signed
   * out, and they are. The API records the real outcome either way.
   */
  const headers = withCookies(result);
  headers.set("Location", "/?signed-out=1");
  return new Response(null, { status: 303, headers });
}

export async function loader() {
  return redirect("/");
}

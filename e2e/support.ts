/**
 * End-to-end test helpers.
 */
import { expect, type Page } from "@playwright/test";

const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

/**
 * The access code `pnpm db:seed` creates, and the one this suite redeems.
 *
 * Shared because it is needed in two places that had drifted apart: the specs
 * that redeem it, and the global setup that has to make sure its campaign is
 * open before they run. The setup used to look the campaign up by a hardcoded
 * `code_last4` of 'THON' — left over from an earlier code ending in
 * "...HACKATHON" — so after the code was renamed the lookup matched nothing and
 * the suite aborted with "run `pnpm db:seed`", advice that could never work
 * because the seed creates a campaign ending 'CESS'. Derived from the code
 * itself now, so renaming it again cannot reintroduce the same drift.
 */
export const SEEDED_CODE = "INKLOOMEARLYACCESS";

/** The campaign's stored `code_last4`, the way the API computes it. */
export const SEEDED_CODE_LAST4 = SEEDED_CODE.replace(/[^A-Z0-9]/g, "").slice(-4);

/**
 * Wait until React has hydrated and the page is genuinely interactive.
 *
 * Not cosmetic. Server-rendered inputs exist in the DOM long before the
 * JavaScript that owns them has loaded, so a test that types immediately is
 * racing hydration and will be flaky in exactly the way that wastes an
 * afternoon. Waiting for React Router to mark the document idle removes the
 * race rather than papering over it with a sleep.
 */
export async function settled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.dataset.hydrated === "true",
    undefined,
    { timeout: 20_000 },
  );

  /*
   * Answer the cookie notice, once, the way a person would.
   *
   * It is a fixed bar at the bottom of every page until someone chooses, so a
   * suite that ignores it spends its life clicking through it. Declining is the
   * right default here: it keeps analytics off during tests, which is also what
   * we want — the suite should not be generating product-analytics events.
   *
   * `cookie-consent.spec.ts` deliberately does NOT call this, so the notice
   * itself is still exercised and audited.
   */
  const reject = page.getByRole("button", { name: "Necessary only" });
  if (await reject.isVisible().catch(() => false)) {
    /*
     * Pressed, not clicked.
     *
     * A mouse click switches the browser's focus modality to pointer, and the
     * focus ring is `:focus-visible` — which correctly does not paint for a
     * mouse. Clicking here made the focus-ring test report that NO element had
     * a visible ring, because the modality had been changed out from under it.
     * A key press leaves the modality where a keyboard test needs it.
     */
    await reject.press("Enter");
    await expect(reject).toBeHidden();
  }
}

/** A fresh address per test, on a TLD that can never resolve. */
export function uniqueEmail(prefix = "e2e"): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
}

export const STRONG_PASSWORD = "a-perfectly-fine-passphrase-1";

/**
 * Where the admin console is mounted, for this checkout.
 *
 * NOT a constant "/admin". The console's prefix is configuration — an obscurity
 * layer that any real deployment sets to something unguessable — and
 * `routes.ts` bakes the configured value into the route table at BUILD time. A
 * developer with ADMIN_PATH in their .env therefore has no /admin at all, and
 * every console journey failed for them with "heading not found" while passing
 * in CI, where no .env exists. The suite reads the same variable the build does.
 */
export const ADMIN = (process.env.ADMIN_PATH ?? "/admin").replace(/\/+$/, "") || "/admin";

/**
 * The console prefix is configurable, so any URL assertion about it has to be
 * built rather than written as a literal — and a prefix may legitimately
 * contain regex metacharacters, so it is escaped before it becomes a pattern.
 */
export function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `adminPath("/users")` -> "<prefix>/users". */
export function adminPath(suffix = ""): string {
  return `${ADMIN}${suffix}`;
}

export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

/**
 * Poll Mailpit for a message to `address`.
 *
 * Reading the real message is the point: it proves the verification link was
 * generated, was addressed correctly, and actually works — none of which a
 * mocked mailer could tell us.
 */
export async function waitForEmail(
  address: string,
  options: { subjectMatch?: RegExp; timeoutMs?: number } = {},
): Promise<{ id: string; subject: string; html: string; text: string }> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);

  while (Date.now() < deadline) {
    const listed = await fetch(`${MAILPIT}/api/v1/messages?limit=50`).then((r) => r.json());
    const match = (listed.messages as MailpitMessage[] | undefined)?.find(
      (m) =>
        m.To.some((t) => t.Address.toLowerCase() === address.toLowerCase()) &&
        (!options.subjectMatch || options.subjectMatch.test(m.Subject)),
    );

    if (match) {
      const full = await fetch(`${MAILPIT}/api/v1/message/${match.ID}`).then((r) => r.json());
      return {
        id: match.ID,
        subject: match.Subject,
        html: String(full.HTML ?? ""),
        text: String(full.Text ?? ""),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  throw new Error(`No email arrived for ${address} within the timeout`);
}

/** Pull the first Inkloom link out of an email body. */
export function linkFrom(html: string, contains = "token="): string {
  const matches = html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  const found = matches.find((url) => url.includes(contains));
  if (!found) throw new Error(`No link containing "${contains}" found in the email`);
  return found.replace(/&amp;/g, "&");
}

export async function clearMailbox(): Promise<void> {
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" }).catch(() => {});
}

/**
 * Sign up, confirm the address, and end signed in.
 *
 * Used as a fixture by tests that are about something else and just need an
 * account to exist.
 */
export async function signUpAndVerify(
  page: Page,
  email = uniqueEmail(),
  name = "E2E Tester",
): Promise<string> {
  await page.goto("/auth/signup");
  await settled(page);

  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(STRONG_PASSWORD);
  await page.getByRole("checkbox", { name: /I agree to the/ }).check();

  // Turnstile needs a moment to mint a token; the button stays disabled until
  // it has one, so waiting on the button is waiting on the right thing.
  const submit = page.getByRole("button", { name: /Create account|Checking/ });
  await expect(submit).toBeEnabled({ timeout: 20_000 });
  await submit.click();

  await page.waitForURL(/\/auth\/check-email/, { timeout: 20_000 });

  const mail = await waitForEmail(email, { subjectMatch: /confirm/i });
  await page.goto(linkFrom(mail.html));
  await settled(page);

  return email;
}

/** Sign in an existing, verified account. */
export async function signIn(page: Page, email: string, password = STRONG_PASSWORD) {
  await page.goto("/auth/login");
  await settled(page);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

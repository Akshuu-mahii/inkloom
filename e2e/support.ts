/**
 * End-to-end test helpers.
 */
import { expect, type Page } from "@playwright/test";

const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

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
}

/** A fresh address per test, on a TLD that can never resolve. */
export function uniqueEmail(prefix = "e2e"): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
}

export const STRONG_PASSWORD = "a-perfectly-fine-passphrase";

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

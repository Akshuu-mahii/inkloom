/**
 * Public endpoints: support intake, analytics ingest and health probes.
 *
 * These are reachable without a session, so each carries its own abuse
 * protection and each is careful about what it reveals.
 */
import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { analyticsEvent, newId, supportRequest } from "@inkloom/db";
import { randomToken } from "@inkloom/core";
import { templates } from "@inkloom/email";
import type { Env } from "../context";
import { apiError, ok } from "../lib/response";
import { body, validateBody } from "../middleware/validate";
import { bySubjectIp, bySubjectUser, rateLimit } from "../middleware/rate-limit";
import { requireAuth } from "../middleware/auth";
import { defer } from "../lib/defer";
import { analyticsEventSchema, supportSchema, type SupportInput } from "../schemas/index";

export const supportRoutes = new Hono<Env>();
export const analyticsRoutes = new Hono<Env>();
export const healthRoutes = new Hono<Env>();

/** Human-quotable reference, e.g. INK-7F3K2Q. Distinct from the internal id. */
function supportReference(): string {
  return `INK-${randomToken(3).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// POST /support
// ---------------------------------------------------------------------------
supportRoutes.post(
  "/",
  rateLimit(
    { bucket: "support.submit.ip", subject: bySubjectIp },
    { bucket: "support.submit.user", subject: bySubjectUser },
  ),
  validateBody(supportSchema),
  async (c) => {
    const input = body<SupportInput>(c);
    const { db, settings, turnstile, mailer, config, audit } = c.get("services");
    const principal = c.get("principal");

    if (!(await settings.isEnabled("support_form_enabled"))) {
      throw apiError("FEATURE_DISABLED", {
        details: { reason: "The support form is temporarily closed." },
      });
    }

    // Anonymous submissions must pass a challenge; a signed-in user has already
    // proven they are a person.
    if (!principal) {
      const verified = await turnstile.verify(input.turnstileToken, c.get("clientIp"));
      if (!verified.success) throw apiError("TURNSTILE_FAILED");
    }

    const reference = supportReference();
    const id = newId("sup");

    await db.insert(supportRequest).values({
      id,
      reference,
      userId: principal?.userId ?? null,
      // A signed-in user's own address wins over anything typed in the form, so
      // a ticket cannot be attributed to someone else's address.
      email: principal?.normalizedEmail ?? input.email,
      name: input.name ?? principal?.name ?? null,
      category: input.category,
      // Security reports jump the queue.
      priority: input.category === "security" ? "high" : "normal",
      subject: input.subject,
      // Stored verbatim as TEXT. It is rendered as text everywhere — never as
      // HTML — so markup in a message is inert, in the admin UI included.
      message: input.message,
      context: {
        path: input.context?.path ?? null,
        userAgent: input.context?.userAgent?.slice(0, 200) ?? null,
      },
      ipHash: c.get("ipHash"),
      requestId: c.get("requestId"),
    });

    /*
     * BOTH EMAILS ARE DEFERRED, and the ticket row above is not.
     *
     * The row is the record; the mail is a courtesy about it. Sending inline
     * put two provider round trips between the insert and the response and
     * made this the slowest endpoint in the application — p95 2500ms, nearly
     * all of it spent waiting on Resend while the user watched a spinner.
     *
     * Worse than slow, it was wrong. A provider hiccup threw AFTER the row had
     * been committed, so the submitter saw a failure for a ticket that existed
     * and submitted it again. Support got duplicates and the sender got no
     * acknowledgement for either. Deferring puts the failure where it belongs:
     * logged, with the ticket safely stored and answerable from the console.
     *
     * The audit record below stays inline — that is evidence, not observation.
     */
    await defer(
      c,
      mailer.send({
        to: principal?.email ?? input.email,
        template: "support_received",
        userId: principal?.userId ?? null,
        force: true,
        rendered: templates.supportReceived(
          { appUrl: config.APP_URL, supportEmail: config.SUPPORT_EMAIL },
          { name: input.name ?? principal?.name, reference, subject: input.subject },
        ),
      }),
      "support.acknowledgement",
    );

    /*
     * And the half that was missing: tell whoever answers support.
     *
     * Only the acknowledgement above existed, so every message thanked the
     * sender and reached nobody. `replyTo` is the sender, so answering goes
     * straight back to them rather than to the support alias.
     */
    await defer(
      c,
      mailer.send({
        to: config.SUPPORT_INBOX ?? config.SUPPORT_EMAIL,
        template: "support_submitted",
        replyTo: principal?.email ?? input.email,
        force: true,
        rendered: templates.supportSubmitted(
          { appUrl: config.APP_URL, supportEmail: config.SUPPORT_EMAIL },
          {
            reference,
            subject: input.subject,
            category: input.category,
            message: input.message,
            fromName: input.name ?? principal?.name,
            fromEmail: principal?.email ?? input.email,
            /*
             * `config.ADMIN_PATH`, not a literal "/admin". The console's prefix
             * is a deployment secret, and "/admin" is a DECOY that returns 404
             * — so the "view this account" link in every support notification
             * led nowhere in exactly the environments where support email
             * matters. The source-level guard that catches this elsewhere only
             * scans apps/web, so this one sat outside it.
             */
            accountUrl: principal
              ? `${config.APP_URL}${config.ADMIN_PATH}/users/${principal.userId}`
              : null,
          },
        ),
      }),
      "support.notification",
    );

    await audit.recordStandalone({
      action: "support.submit",
      actorType: principal ? "user" : "system",
      actorId: principal?.userId ?? null,
      targetType: "support_request",
      targetId: id,
      metadata: { category: input.category, reference },
      requestId: c.get("requestId"),
      ipHash: c.get("ipHash"),
    });

    return ok(c, { reference, status: "open" });
  },
);

// ---------------------------------------------------------------------------
// GET /support/:id — status of one's own request
// ---------------------------------------------------------------------------
supportRoutes.get("/:id", requireAuth, async (c) => {
  const principal = c.get("principal")!;
  const { db } = c.get("services");
  const idOrReference = c.req.param("id");

  // Scoped to the caller's own requests. Someone else's reference resolves to
  // nothing, so references cannot be enumerated.
  const found = await db.query.supportRequest.findFirst({
    where: and(
      eq(supportRequest.userId, principal.userId),
      idOrReference.startsWith("sup_")
        ? eq(supportRequest.id, idOrReference)
        : eq(supportRequest.reference, idOrReference.toUpperCase()),
    ),
  });

  if (!found) throw apiError("NOT_FOUND");

  return ok(c, {
    reference: found.reference,
    subject: found.subject,
    category: found.category,
    status: found.status,
    createdAt: found.createdAt,
    updatedAt: found.updatedAt,
    // The user-visible resolution note only. Internal admin notes are a
    // separate table and are never joined into this response.
    resolution: found.resolutionNote,
  });
});

// ---------------------------------------------------------------------------
// POST /analytics — first-party product events
// ---------------------------------------------------------------------------
analyticsRoutes.post(
  "/",
  rateLimit({ bucket: "analytics.ingest.ip", subject: bySubjectIp }),
  validateBody(analyticsEventSchema),
  async (c) => {
    const { db, settings } = c.get("services");
    const principal = c.get("principal");
    const input = body<{
      name: string;
      anonymousId?: string;
      path?: string;
      utm?: { source?: string; medium?: string; campaign?: string };
      referrer?: string;
      landingPath?: string;
      properties?: Record<string, string | number | boolean>;
    }>(c);

    if (!(await settings.isEnabled("analytics_enabled"))) {
      // Silently accepted so the client never has to branch on it.
      return ok(c, { recorded: false });
    }

    await db.insert(analyticsEvent).values({
      id: newId("evt"),
      name: input.name,
      anonymousId: input.anonymousId ?? null,
      // Attached only for an authenticated caller, and only ever server-side.
      userId: principal?.userId ?? null,
      deviceCategory: deviceCategory(c.req.header("user-agent")),
      utmSource: input.utm?.source ?? null,
      utmMedium: input.utm?.medium ?? null,
      utmCampaign: input.utm?.campaign ?? null,
      referrer: input.referrer ?? null,
      landingPath: input.landingPath ?? null,
      path: input.path ?? null,
      // Already constrained by the schema to bounded scalars, so an email or an
      // access code cannot be smuggled in here.
      properties: input.properties ?? {},
    });

    return ok(c, { recorded: true });
  },
);

function deviceCategory(userAgent: string | undefined): string {
  if (!userAgent) return "unknown";
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet|playbook|silk/.test(ua)) return "tablet";
  if (/mobi|android|iphone|ipod/.test(ua)) return "mobile";
  return "desktop";
}

// ---------------------------------------------------------------------------
// Health probes
// ---------------------------------------------------------------------------

/**
 * Liveness. Answers "is this Worker running?" and deliberately nothing else —
 * no version, no hostname, no dependency detail. A public probe must not become
 * a reconnaissance endpoint.
 */
healthRoutes.get("/health", (c) => c.json({ status: "ok" }, 200));

/**
 * Readiness. Checks the database, because a Worker that cannot reach Postgres
 * cannot serve a single useful request.
 *
 * On failure it returns 503 with the literal string "unavailable" — the driver
 * error goes to the log with the request id, never to the caller.
 */
healthRoutes.get("/ready", async (c) => {
  const { db, logger } = c.get("services");
  const startedAt = Date.now();

  try {
    await db.execute(sql`SELECT 1`);
    return c.json({ status: "ready", checks: { database: "ok" } }, 200);
  } catch (error) {
    logger.error("readiness_check_failed", { error, durationMs: Date.now() - startedAt });
    return c.json({ status: "unavailable", checks: { database: "unavailable" } }, 503);
  }
});

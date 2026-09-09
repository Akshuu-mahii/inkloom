/**
 * Credits and access-code redemption.
 */
import { Hono } from "hono";
import { newId } from "@inkloom/db";
import { RedemptionError, RedemptionService } from "@inkloom/core/access-codes";
import { templates } from "@inkloom/email";
import type { Env } from "../context";
import { ok, paged } from "../lib/response";
import { body, query, validateBody, validateQuery } from "../middleware/validate";
import { requireAuth, requireVerified } from "../middleware/auth";
import { bySubjectIp, bySubjectUser, rateLimit } from "../middleware/rate-limit";
import { paginationSchema, redeemCodeSchema, type RedeemCodeInput } from "../schemas/index";

export const creditRoutes = new Hono<Env>();
export const codeRoutes = new Hono<Env>();

creditRoutes.use("*", requireAuth);

// ---------------------------------------------------------------------------
// GET /credits
// ---------------------------------------------------------------------------
creditRoutes.get("/", async (c) => {
  const principal = c.get("principal")!;
  const { credits } = c.get("services");

  // Always read from the wallet, never from anything the client supplied.
  const wallet = await credits.getBalance(principal.userId);

  return ok(c, {
    balance: wallet.balance,
    /**
     * V1 credits are promotional and cannot be spent yet — generation is not
     * built. Saying so here keeps the UI honest without the client having to
     * infer it.
     */
    spendable: false,
    currency: "credits",
    note: "Early-access credits are promotional and become spendable when logo generation opens.",
  });
});

// ---------------------------------------------------------------------------
// GET /credits/history
// ---------------------------------------------------------------------------
creditRoutes.get("/history", validateQuery(paginationSchema), async (c) => {
  const principal = c.get("principal")!;
  const { credits } = c.get("services");
  const { limit, cursor } = query<{ limit: number; cursor?: string }>(c);

  // Scoped to the principal — there is no `userId` parameter to tamper with.
  const history = await credits.history({
    userId: principal.userId,
    limit,
    before: cursor ? new Date(cursor) : undefined,
  });

  return ok(
    c,
    paged(
      history.entries.map((e) => ({
        id: e.id,
        amount: e.amount,
        type: e.type,
        balanceAfter: e.balanceAfter,
        reason: e.reason,
        createdAt: e.createdAt,
        // Only the campaign NAME, never its configuration or fingerprint.
        campaignName: e.metadata.campaignName ?? null,
      })),
      history.nextCursor,
    ),
  );
});

// ---------------------------------------------------------------------------
// POST /access-codes/redeem
// ---------------------------------------------------------------------------
codeRoutes.post(
  "/redeem",
  requireAuth,
  // A verified email is a precondition for any credit grant.
  requireVerified,
  // Limited on both axes. Only FAILED attempts count (the limiter policy sets
  // countFailuresOnly), so a legitimate user is never punished for succeeding.
  rateLimit(
    { bucket: "code.redeem.user", subject: bySubjectUser },
    { bucket: "code.redeem.ip", subject: bySubjectIp },
  ),
  validateBody(redeemCodeSchema),
  async (c) => {
    const principal = c.get("principal")!;
    const input = body<RedeemCodeInput>(c);
    const { redemption, settings, audit, mailer, config, limiter } = c.get("services");

    const redemptionEnabled = await settings.isEnabled("code_redemption_enabled");

    try {
      const result = await redemption.redeem(
        {
          userId: principal.userId,
          code: input.code,
          // Server-generated when the client omits one, so a forgetful client
          // still cannot double-grant on a retry.
          idempotencyKey: input.idempotencyKey ?? newId("idem"),
          ipHash: c.get("ipHash"),
          requestId: c.get("requestId"),
        },
        {
          // Every fact comes from the server-resolved principal, never the body.
          emailVerified: principal.emailVerified,
          userStatus: principal.status,
          normalizedEmail: principal.normalizedEmail,
          redemptionEnabled,
        },
      );

      // A successful redeem clears the failure counters.
      await limiter.reset("code.redeem.user", `user:${principal.userId}`);

      if (!result.replayed) {
        await mailer.send({
          to: principal.email,
          template: "code_redeemed",
          userId: principal.userId,
          rendered: templates.codeRedeemed(
            { appUrl: config.APP_URL, supportEmail: config.SUPPORT_EMAIL },
            {
              name: principal.name,
              campaignName: result.campaignName,
              credits: result.creditsGranted,
              balance: result.balance,
            },
          ),
        });
      }

      return ok(c, {
        creditsGranted: result.creditsGranted,
        // The authoritative balance, read inside the transaction.
        balance: result.balance,
        campaignName: result.campaignName,
        alreadyRedeemed: result.replayed,
      });
    } catch (error) {
      if (error instanceof RedemptionError) {
        // The TRUE reason goes to the security log for operators...
        await audit.security({
          type: "access_code_failed",
          severity: error.reason === "unknown_code" ? "info" : "warning",
          userId: principal.userId,
          ipHash: c.get("ipHash"),
          requestId: c.get("requestId"),
          metadata: { reason: error.reason, campaignId: error.campaignId },
        });
        // ...while the caller gets one of three deliberately uninformative
        // messages, so campaign existence and state stay unmappable.
        throw RedemptionService.toClientError(error);
      }
      throw error;
    }
  },
);

// ---------------------------------------------------------------------------
// GET /access-codes/status — is redemption currently open?
// ---------------------------------------------------------------------------
codeRoutes.get("/status", requireAuth, async (c) => {
  const { settings } = c.get("services");
  return ok(c, { enabled: await settings.isEnabled("code_redemption_enabled") });
});

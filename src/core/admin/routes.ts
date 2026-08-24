import { Router } from "express";
import { adminUiRouter } from "./ui/index.js";
import { requireAdminUiAuth } from "./ui/authMiddleware.js";
import { makeRequireAdminAuth } from "./auth.js";
import { config } from "../config.js";
import {
  abortReputationOutcome,
  reconcileReputationOutcome,
  retryReputationOutcomeOnce,
} from "../standardRail/reputationOutcome.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import { pool } from "../db/pool.js";
import type { Hex } from "viem";
import { logWarn } from "../logger.js";
import { getOperationsSummary } from "../operations/summary.js";

// Admin surface. Two auth modes:
//   * /admin/ui/* — cookie session (SIWE login), used by the operator UI.
//   * /admin/* (all other JSON endpoints) — bearer ADMIN_TOKEN, used by
//     ops scripts and CI.
//
// The JSON API surface was significantly reduced in v4 — most of what the
// old /admin/* endpoints did is now exposed via the new admin UI pages
// (which the operator drives interactively). A minimal JSON API survives
// for ops scripts; richer endpoints can be added back as they're needed.

export const requireAdminAuth = makeRequireAdminAuth(() => config.ADMIN_TOKEN);

export const adminRouter = Router();

// /admin/ui/* uses cookie-session auth (HTMX UI). Mount BEFORE the
// bearer-token middleware so the cookie path doesn't get gated on a token.
adminRouter.use("/ui", requireAdminUiAuth, adminUiRouter);

// All other /admin/* endpoints are bearer-gated.
adminRouter.use(requireAdminAuth);

// /admin/health — bearer-protected liveness check. Useful for CI scripts
// that want to verify ADMIN_TOKEN is good before doing real work.
adminRouter.get("/health", async (_req, res) => {
  res.json({ ok: true, ...await getOperationsSummary() });
});

const reasonClasses = new Set([
  "rpc_finality", "balance_fee", "nonce_conflict", "contract_rejection", "application_fault",
]);

function exactRecoveryAuthority(req: import("express").Request): {
  actor: string;
  reasonClass: string;
} {
  const actor = req.get("x-admin-actor");
  const body = req.body as Record<string, unknown> | null;
  if (!actor || !/^[A-Za-z0-9@._-]{1,128}$/.test(actor) ||
    !body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).length !== 1 || typeof body.reasonClass !== "string" ||
    !reasonClasses.has(body.reasonClass)) throw new Error("invalid recovery authority");
  return { actor, reasonClass: body.reasonClass };
}

adminRouter.post("/reputation/outcomes/:orderKey/:action", async (req, res) => {
  try {
    const orderKey = String(req.params.orderKey) as Hex;
    const action = String(req.params.action);
    const authority = exactRecoveryAuthority(req);
    if (
      !/^0x[0-9a-f]{64}$/.test(orderKey) ||
      !["reconcile", "retry-once", "abort"].includes(action)
    ) throw new Error("invalid recovery action");
    const result = action === "reconcile"
      ? await reconcileReputationOutcome(orderKey)
      : action === "retry-once"
        ? await retryReputationOutcomeOnce(orderKey).then(() => "pending")
        : await abortReputationOutcome(orderKey).then(() => "aborted_unattested");
    await recordMandatoryAudit(pool, {
      source: "admin",
      severity: "warn",
      type: `standard.reputation.outcome.${action}`,
      actor: authority.actor,
      message: `Provider reputation outcome recovery action ${action} completed.`,
      payload: { action, reasonClass: authority.reasonClass },
    });
    if (action === "abort") {
      logWarn("Provider reputation outcome aborted unattested", {
        orderKey,
        actor: authority.actor,
        reasonClass: authority.reasonClass,
      });
    }
    res.json({ ok: true, state: result });
  } catch {
    res.status(409).json({ error: "reputation_outcome_action_rejected" });
  }
});

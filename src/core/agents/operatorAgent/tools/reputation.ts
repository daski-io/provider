import type { Hex } from "viem";
import { pool } from "../../../db/pool.js";
import {
  closeOpenReviewsForTarget,
  getEscalationById,
} from "../../../db/queries/escalations.js";
import { recordMandatoryAudit } from "../../../events/emitter.js";
import {
  abortReputationOutcome,
  reconcileReputationOutcome,
  retryReputationOutcomeOnce,
} from "../../../standardRail/reputationOutcome.js";
import {
  REPUTATION_OUTCOME_REVIEW_KIND,
  REPUTATION_OUTCOME_TARGET_TYPE,
} from "../../../standardRail/reputationOutcomeReviews.js";
import { confirmationGate, executeConfirmedAction } from "../confirmation.js";
import { confirmationPendingResult } from "../confirmationPresentation.js";
import type { OperatorTool, ToolContext } from "./shared.js";

const ORDER_KEY_RE = /^0x[0-9a-f]{64}$/i;
const REASON_CLASSES = new Set([
  "rpc_finality",
  "balance_fee",
  "nonce_conflict",
  "contract_rejection",
  "application_fault",
]);
const OPEN_REVIEW_STATES = new Set([
  "pending",
  "in_agent_review",
  "awaiting_human",
  "resolution_attention",
]);

interface OutcomeState {
  state: string;
  providerWriteId: string | null;
  attemptCount: number;
  retryOnceUsed: boolean;
  errorClass: string | null;
}

async function loadOutcome(orderKey: Hex): Promise<OutcomeState | null> {
  const result = await pool.query<{
    state: string;
    provider_write_id: string | null;
    attempt_count: number;
    retry_once_used: boolean;
    last_error_class: string | null;
  }>(
    `SELECT state,provider_write_id,attempt_count,retry_once_used,last_error_class
       FROM standard_reputation_outcomes WHERE order_key=$1`,
    [Buffer.from(orderKey.slice(2), "hex")],
  );
  const row = result.rows[0];
  return row ? {
    state: row.state,
    providerWriteId: row.provider_write_id,
    attemptCount: row.attempt_count,
    retryOnceUsed: row.retry_once_used,
    errorClass: row.last_error_class,
  } : null;
}

async function boundReview(ctx: ToolContext, orderKey: Hex) {
  if (!ctx.escalationId || ctx.mode !== "human") return null;
  const review = await getEscalationById(ctx.escalationId);
  return review
    && review.review_kind === REPUTATION_OUTCOME_REVIEW_KIND
    && review.target_type === REPUTATION_OUTCOME_TARGET_TYPE
    && review.target_id?.toLowerCase() === orderKey.toLowerCase()
    && OPEN_REVIEW_STATES.has(review.status)
    ? review
    : null;
}

function actionTool(args: {
  name: "reconcile_reputation_outcome" | "retry_reputation_outcome_once" |
    "abort_reputation_outcome";
  description: string;
  action: "reconcile" | "retry-once" | "abort";
}): OperatorTool {
  return {
    definition: {
      type: "function",
      function: {
        name: args.name,
        description: `${args.description} Requires exact browser approval.`,
        parameters: {
          type: "object",
          properties: {
            order_key: { type: "string", description: "The standard order key (bytes32)." },
            reason_class: {
              type: "string",
              enum: [...REASON_CLASSES],
              description: "The operator's classified reason for the recovery action.",
            },
          },
          required: ["order_key", "reason_class"],
        },
      },
    },
    async execute(input, ctx) {
      if (!ctx.escalationId || ctx.mode !== "human") {
        return JSON.stringify({ ok: false, reason: "reputation_outcome_review_required" });
      }
      const orderKey = String(input.order_key ?? "") as Hex;
      const reasonClass = String(input.reason_class ?? "");
      if (!ORDER_KEY_RE.test(orderKey) || !REASON_CLASSES.has(reasonClass)) {
        return JSON.stringify({ ok: false, reason: "invalid_recovery_request" });
      }
      const review = await boundReview(ctx, orderKey);
      if (!review) {
        return JSON.stringify({ ok: false, reason: "stale_or_mismatched_review" });
      }
      const outcome = await loadOutcome(orderKey);
      if (!outcome) return JSON.stringify({ ok: false, reason: "outcome_not_found" });
      const confirmation = await confirmationGate({
        ctx,
        actionName: args.name,
        arguments: {
          order_key: orderKey.toLowerCase(),
          action: args.action,
          current_state: outcome.state,
          provider_write_id: outcome.providerWriteId,
          attempt_count: outcome.attemptCount,
        },
        payload: { reason_class: reasonClass },
        targetType: "standard_reputation_outcome",
        targetId: orderKey.toLowerCase(),
      });
      if (confirmation.status === "pending") {
        return confirmationPendingResult(confirmation, {
          message: `${args.action} standard reputation outcome ${orderKey}.`,
          pending: { order_key: orderKey, action: args.action, reason_class: reasonClass },
        });
      }
      if (confirmation.status === "denied") {
        return JSON.stringify({ ok: false, reason: confirmation.reason, message: confirmation.message });
      }
      const result = await executeConfirmedAction(confirmation, async () => {
        const state = args.action === "reconcile"
          ? await reconcileReputationOutcome(orderKey)
          : args.action === "retry-once"
            ? await retryReputationOutcomeOnce(orderKey).then(() => "pending")
            : await abortReputationOutcome(orderKey).then(() => "aborted_unattested");
        const shouldClose = args.action !== "reconcile" || state === "final";
        const closedReviewIds = shouldClose
          ? await closeOpenReviewsForTarget({
              targetType: REPUTATION_OUTCOME_TARGET_TYPE,
              targetId: orderKey.toLowerCase(),
              reviewKind: REPUTATION_OUTCOME_REVIEW_KIND,
              resolvedBy: ctx.actor,
              response: `Reputation recovery decision completed with state ${state}.`,
            })
          : [];
        await recordMandatoryAudit(pool, {
          source: "admin",
          severity: "warn",
          actor: ctx.actor,
          type: `standard.reputation.outcome.${args.action}`,
          message: `Provider reputation outcome recovery action ${args.action} completed.`,
          payload: { action: args.action, reasonClass: confirmation.payload.reason_class, escalationId: review.id },
        });
        return { state, closedReviewIds };
      });
      if (result.closedReviewIds.includes(review.id)) ctx.escalationClosed = true;
      return JSON.stringify({ ok: true, state: result.state });
    },
  };
}

export const reconcileReputationOutcomeTool = actionTool({
  name: "reconcile_reputation_outcome",
  action: "reconcile",
  description: "Reconcile the exact persisted provider write before choosing another action.",
});

export const retryReputationOutcomeOnceTool = actionTool({
  name: "retry_reputation_outcome_once",
  action: "retry-once",
  description: "Use the standard outcome's single bounded retry after reconciliation proves it safe.",
});

export const abortReputationOutcomeTool = actionTool({
  name: "abort_reputation_outcome",
  action: "abort",
  description: "Abort an unattested standard outcome only when no provider write can execute.",
});

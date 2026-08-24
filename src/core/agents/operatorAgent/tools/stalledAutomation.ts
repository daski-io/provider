import { confirmationGate, executeConfirmedAction } from "../confirmation.js";
import { confirmationPendingResult } from "../confirmationPresentation.js";
import { pool } from "../../../db/pool.js";
import { requeueDeadLetterById } from "../../../db/queries/durableJobs.js";
import {
  closeEscalation,
  getEscalationById,
} from "../../../db/queries/escalations.js";
import { inTransaction } from "../../../db/queryable.js";
import { recordMandatoryAudit } from "../../../events/emitter.js";
import {
  DURABLE_JOB_TARGET_TYPE,
  STALLED_AUTOMATION_REVIEW_KIND,
} from "../../../operations/stalledAutomationReviews.js";
import type { OperatorTool } from "./shared.js";

const OPEN_REVIEW_STATES = new Set([
  "pending",
  "in_agent_review",
  "awaiting_human",
  "resolution_attention",
]);

export const retryStalledAutomationTool: OperatorTool = {
  definition: {
    type: "function",
    function: {
      name: "retry_stalled_automation",
      description:
        "Reset and requeue the exact dead-lettered job bound to the current Review. "
        + "Requires exact browser approval.",
      parameters: {
        type: "object",
        properties: {
          job_id: { type: "string" },
        },
        required: ["job_id"],
        additionalProperties: false,
      },
    },
  },
  async execute(args, ctx) {
    if (!ctx.escalationId || ctx.mode !== "human") {
      return JSON.stringify({ ok: false, reason: "stalled_automation_review_required" });
    }
    const jobId = String(args.job_id ?? "");
    const review = await getEscalationById(ctx.escalationId);
    if (
      !review
      || review.review_kind !== STALLED_AUTOMATION_REVIEW_KIND
      || review.target_type !== DURABLE_JOB_TARGET_TYPE
      || review.target_id !== jobId
      || !OPEN_REVIEW_STATES.has(review.status)
    ) {
      return JSON.stringify({ ok: false, reason: "stale_or_mismatched_review" });
    }
    const confirmation = await confirmationGate({
      ctx,
      actionName: "retry_stalled_automation",
      arguments: { job_id: jobId, review_id: review.id },
      payload: {},
      targetType: DURABLE_JOB_TARGET_TYPE,
      targetId: jobId,
    });
    if (confirmation.status === "pending") {
      return confirmationPendingResult(confirmation, {
        message: `Reset the retry budget and requeue durable job ${jobId}.`,
        pending: { job_id: jobId },
      });
    }
    if (confirmation.status === "denied") {
      return JSON.stringify({
        ok: false,
        reason: confirmation.reason,
        message: confirmation.message,
      });
    }
    await executeConfirmedAction(confirmation, () => inTransaction(pool, async (db) => {
      if (!await requeueDeadLetterById(jobId, db)) {
        throw new Error("The reviewed job is no longer dead-lettered");
      }
      const closed = await closeEscalation({
        id: review.id,
        status: "resolved",
        resolved_by: ctx.actor,
        response: "Operator reset the retry budget and returned the job to automation.",
      }, db);
      if (!closed) throw new Error("The stalled-automation Review is no longer open");
      await recordMandatoryAudit(db, {
        transactionId: review.transaction_id ?? undefined,
        source: "admin",
        actor: ctx.actor,
        type: "review.stalled_automation.retried",
        message: "An operator returned a dead-lettered job to its durable worker.",
        payload: { escalationId: review.id, jobId },
      });
    }));
    ctx.escalationClosed = true;
    return JSON.stringify({ ok: true, job_id: jobId, status: "queued" });
  },
};

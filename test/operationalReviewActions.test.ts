import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  getEscalationById: vi.fn(),
  closeOpenReviewsForTarget: vi.fn(),
  closeEscalation: vi.fn(),
  confirmationGate: vi.fn(),
  reconcileReputationOutcome: vi.fn(),
  retryReputationOutcomeOnce: vi.fn(),
  abortReputationOutcome: vi.fn(),
  requeueDeadLetterById: vi.fn(),
  recordMandatoryAudit: vi.fn(),
}));

vi.mock("../src/core/db/pool.js", () => ({ pool: { query: h.query } }));
vi.mock("../src/core/db/queries/escalations.js", () => ({
  getEscalationById: h.getEscalationById,
  closeOpenReviewsForTarget: h.closeOpenReviewsForTarget,
  closeEscalation: h.closeEscalation,
}));
vi.mock("../src/core/standardRail/reputationOutcome.js", () => ({
  reconcileReputationOutcome: h.reconcileReputationOutcome,
  retryReputationOutcomeOnce: h.retryReputationOutcomeOnce,
  abortReputationOutcome: h.abortReputationOutcome,
}));
vi.mock("../src/core/db/queries/durableJobs.js", () => ({
  requeueDeadLetterById: h.requeueDeadLetterById,
}));
vi.mock("../src/core/db/queryable.js", () => ({
  inTransaction: vi.fn(async (_pool, work) => work({ query: h.query })),
}));
vi.mock("../src/core/events/emitter.js", () => ({
  recordMandatoryAudit: h.recordMandatoryAudit,
}));
vi.mock("../src/core/agents/operatorAgent/confirmation.js", () => ({
  confirmationGate: h.confirmationGate,
  executeConfirmedAction: vi.fn(async (_confirmation, work) => work()),
}));

import {
  retryReputationOutcomeOnceTool,
} from "../src/core/agents/operatorAgent/tools/reputation.js";
import {
  retryStalledAutomationTool,
} from "../src/core/agents/operatorAgent/tools/stalledAutomation.js";
import type { ToolContext } from "../src/core/agents/operatorAgent/tools/shared.js";

const reviewId = "11111111-1111-4111-8111-111111111111";
const orderKey = `0x${"ab".repeat(32)}`;

function context(): ToolContext {
  return {
    actor: "0xoperator",
    mode: "human" as const,
    escalationId: reviewId,
    directAdminApproval: true as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.confirmationGate.mockResolvedValue({
    status: "approved",
    intentId: "direct-admin",
    payload: { reason_class: "balance_fee" },
  });
  h.closeOpenReviewsForTarget.mockResolvedValue([reviewId]);
  h.closeEscalation.mockResolvedValue({ id: reviewId });
  h.retryReputationOutcomeOnce.mockResolvedValue(undefined);
  h.requeueDeadLetterById.mockResolvedValue(true);
  h.recordMandatoryAudit.mockResolvedValue(undefined);
  h.query.mockResolvedValue({
    rows: [{
      state: "operator_attention",
      provider_write_id: null,
      attempt_count: 5,
      retry_once_used: false,
      last_error_class: "balance_fee",
    }],
    rowCount: 1,
  });
});

describe("operational Review actions", () => {
  it("does not expose reputation recovery outside a Review", async () => {
    const result = JSON.parse(await retryReputationOutcomeOnceTool.execute(
      { order_key: orderKey, reason_class: "balance_fee" },
      { actor: "0xoperator", mode: "free_form" },
    ));
    expect(result).toEqual({
      ok: false,
      reason: "reputation_outcome_review_required",
    });
    expect(h.confirmationGate).not.toHaveBeenCalled();
  });

  it("rejects a recovery request that is not bound to the current Review target", async () => {
    h.getEscalationById.mockResolvedValue({
      id: reviewId,
      status: "awaiting_human",
      review_kind: "reputation_outcome_recovery",
      target_type: "standard_reputation_outcome",
      target_id: `0x${"cd".repeat(32)}`,
    });
    const result = JSON.parse(await retryReputationOutcomeOnceTool.execute(
      { order_key: orderKey, reason_class: "balance_fee" },
      context(),
    ));
    expect(result).toEqual({ ok: false, reason: "stale_or_mismatched_review" });
    expect(h.retryReputationOutcomeOnce).not.toHaveBeenCalled();
  });

  it("retries the bound reputation report and resolves its Review", async () => {
    h.getEscalationById.mockResolvedValue({
      id: reviewId,
      status: "awaiting_human",
      transaction_id: "standard-tx-1",
      review_kind: "reputation_outcome_recovery",
      target_type: "standard_reputation_outcome",
      target_id: orderKey,
    });
    const ctx = context();
    const result = JSON.parse(await retryReputationOutcomeOnceTool.execute(
      { order_key: orderKey, reason_class: "balance_fee" },
      ctx,
    ));

    expect(result).toEqual({ ok: true, state: "pending" });
    expect(h.retryReputationOutcomeOnce).toHaveBeenCalledWith(orderKey);
    expect(h.closeOpenReviewsForTarget).toHaveBeenCalledWith({
      targetType: "standard_reputation_outcome",
      targetId: orderKey,
      reviewKind: "reputation_outcome_recovery",
      resolvedBy: "0xoperator",
      response: "Reputation recovery decision completed with state pending.",
    });
    expect(ctx.escalationClosed).toBe(true);
  });

  it("requeues only the dead letter bound to the current stalled-automation Review", async () => {
    h.getEscalationById.mockResolvedValue({
      id: reviewId,
      status: "awaiting_human",
      transaction_id: null,
      review_kind: "stalled_automation",
      target_type: "durable_job",
      target_id: "job-1",
    });
    const ctx = context();
    const result = JSON.parse(await retryStalledAutomationTool.execute(
      { job_id: "job-1" },
      ctx,
    ));

    expect(result).toEqual({ ok: true, job_id: "job-1", status: "queued" });
    expect(h.requeueDeadLetterById).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ query: h.query }),
    );
    expect(h.closeEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ id: reviewId, resolved_by: "0xoperator" }),
      expect.objectContaining({ query: h.query }),
    );
    expect(ctx.escalationClosed).toBe(true);
  });
});

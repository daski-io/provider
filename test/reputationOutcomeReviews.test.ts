import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  createHumanEscalation: vi.fn(),
  closeEscalation: vi.fn(),
}));

vi.mock("../src/core/db/pool.js", () => ({ pool: {} }));
vi.mock("../src/core/db/queryable.js", () => ({
  inTransaction: vi.fn(async (_pool, work) => work({ query: h.query })),
}));
vi.mock("../src/core/engine/escalation.js", () => ({
  createHumanEscalation: h.createHumanEscalation,
}));
vi.mock("../src/core/db/queries/escalations.js", () => ({
  closeEscalation: h.closeEscalation,
}));

import {
  reconcileReputationOutcomeReviews,
  REPUTATION_OUTCOME_REVIEW_KIND,
  surfaceReputationOutcomeReview,
} from "../src/core/standardRail/reputationOutcomeReviews.js";

const orderKey = Buffer.from("ab".repeat(32), "hex");
const targetId = `0x${"ab".repeat(32)}`;

function row(overrides: Record<string, unknown> = {}) {
  return {
    order_key: orderKey,
    transaction_id: "standard-tx-1",
    outcome: 1,
    provider_write_id: null,
    attempt_count: 5,
    retry_once_used: false,
    last_error_class: "balance_fee",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.createHumanEscalation.mockResolvedValue({});
  h.closeEscalation.mockResolvedValue({ id: "review-final" });
  h.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("reputation outcome Reviews", () => {
  it("creates a plain-language decision with only actions safe for an unbroadcast outcome", async () => {
    await surfaceReputationOutcomeReview({
      row: row(),
      reason: "balance_fee",
    });

    expect(h.createHumanEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "auto",
        transactionId: "standard-tx-1",
        question: "Marketplace reputation update for transaction standard-tx-1 needs a decision.",
        review: expect.objectContaining({
          kind: REPUTATION_OUTCOME_REVIEW_KIND,
          severity: "critical",
          target: { type: "standard_reputation_outcome", id: targetId },
        }),
        suggestedActions: [
          expect.objectContaining({ label: "Retry once" }),
          expect.objectContaining({ label: "Stop trying" }),
        ],
      }),
      undefined,
    );
    const review = h.createHumanEscalation.mock.calls[0]![0];
    expect(JSON.parse(review.suggestedActions[0].value)).toEqual({
      tool: "retry_reputation_outcome_once",
      arguments: { order_key: targetId, reason_class: "balance_fee" },
    });
  });

  it("offers reconciliation instead of a duplicate write when a saved write exists", async () => {
    await surfaceReputationOutcomeReview({
      row: row({ provider_write_id: "write-1" }),
      reason: "rpc_finality",
    });

    const review = h.createHumanEscalation.mock.calls[0]![0];
    expect(review.suggestedActions).toEqual([
      expect.objectContaining({ label: "Check submitted transaction" }),
    ]);
    expect(JSON.parse(review.suggestedActions[0].value).tool)
      .toBe("reconcile_reputation_outcome");
  });

  it("backfills parked outcomes and closes Reviews whose state already recovered", async () => {
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT e.id,o.state")) {
        return { rows: [{ id: "review-final", state: "final" }], rowCount: 1 };
      }
      if (sql.includes("SELECT o.order_key")) {
        return { rows: [row()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(reconcileReputationOutcomeReviews()).resolves.toEqual({
      opened: 1,
      closed: 1,
    });
    expect(h.closeEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "review-final",
        resolved_by: "system",
        response: "Reputation report finalized on chain.",
      }),
      expect.objectContaining({ query: h.query }),
    );
    expect(h.createHumanEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        review: expect.objectContaining({
          target: { type: "standard_reputation_outcome", id: targetId },
        }),
      }),
      expect.objectContaining({ query: h.query }),
    );
  });
});

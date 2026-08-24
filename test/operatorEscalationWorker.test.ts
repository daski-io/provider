import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  renew: vi.fn(),
  process: vi.fn(),
  handoff: vi.fn(),
}));

vi.mock("../src/core/db/queries/durableJobs.js", () => ({
  claimDurableJob: h.claim,
  completeDurableJob: h.complete,
  failDurableJob: h.fail,
  renewDurableJobLease: h.renew,
}));
vi.mock("../src/core/db/queries/escalations.js", () => ({
  OPERATOR_ESCALATION_QUEUE: "operator-escalation",
  markEscalationAwaitingHuman: h.handoff,
}));
vi.mock("../src/core/agents/operatorAgent/escalationRunner.js", () => ({
  processEscalation: h.process,
}));
vi.mock("../src/core/health.js", () => ({
  failWorker: vi.fn(), heartbeatWorker: vi.fn(), setWorkerStatus: vi.fn(),
}));
vi.mock("../src/core/logger.js", () => ({ logError: vi.fn() }));

import { runOperatorEscalationOnce } from "../src/core/agents/operatorAgent/escalationWorker.js";

const job = {
  id: "job-1",
  payload: { escalationId: "review-1" },
  lease_token: "lease-1",
  attempts: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.claim.mockResolvedValue(job);
  h.process.mockResolvedValue(undefined);
  h.complete.mockResolvedValue(true);
  h.fail.mockResolvedValue("retry");
  h.renew.mockResolvedValue(true);
  h.handoff.mockResolvedValue({ id: "review-1", status: "awaiting_human" });
});

describe("bounded operator escalation worker", () => {
  it("claims and completes the durable email-triage job", async () => {
    await expect(runOperatorEscalationOnce()).resolves.toBe(true);
    expect(h.claim).toHaveBeenCalledWith(expect.objectContaining({
      queue: "operator-escalation",
      leaseSeconds: 300,
    }));
    expect(h.process).toHaveBeenCalledWith("review-1");
    expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({
      id: "job-1",
      leaseToken: "lease-1",
    }));
  });

  it("hands a dead-lettered review to a human", async () => {
    h.process.mockRejectedValue(new Error("model unavailable"));
    h.fail.mockResolvedValue("dead_letter");
    await expect(runOperatorEscalationOnce()).resolves.toBe(true);
    expect(h.handoff).toHaveBeenCalledWith({
      id: "review-1",
      agent_recommendation:
        "Automated triage exhausted its retry budget. Human review is required.",
    });
  });

  it("does nothing when the queue is empty", async () => {
    h.claim.mockResolvedValue(null);
    await expect(runOperatorEscalationOnce()).resolves.toBe(false);
    expect(h.process).not.toHaveBeenCalled();
  });
});

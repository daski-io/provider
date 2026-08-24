import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  enqueue: vi.fn(),
  audit: vi.fn(),
  db: { query: vi.fn() } as { query: ReturnType<typeof vi.fn> },
}));

vi.mock("../src/core/db/pool.js", () => ({ pool: {} }));
vi.mock("../src/core/db/queryable.js", () => ({
  inTransaction: vi.fn(async (_pool, work) => work(h.db)),
}));
vi.mock("../src/core/db/queries/durableJobs.js", () => ({
  enqueueDurableJob: h.enqueue,
}));
vi.mock("../src/core/events/emitter.js", () => ({
  recordMandatoryAudit: h.audit,
}));
vi.mock("../src/core/security/escalationProtection.js", () => ({
  protectEscalationText: vi.fn((_id, _field, value) => value ?? null),
  revealEscalationFields: vi.fn((row) => row),
}));

import {
  createEscalation,
  OPERATOR_ESCALATION_QUEUE,
} from "../src/core/db/queries/escalations.js";

beforeEach(() => {
  vi.clearAllMocks();
  h.db.query = h.query;
  h.query
    .mockResolvedValueOnce({
      rows: [{
        id: "review-1",
        transaction_id: null,
        status: "in_agent_review",
        assignee: "operator_agent",
      }],
      rowCount: 1,
    })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });
  h.enqueue.mockResolvedValue({ id: "job-1" });
});

describe("operator escalation queue persistence", () => {
  it("persists the review, durable job binding, and audit in one transaction", async () => {
    await createEscalation({
      transaction_id: null,
      question: "Triage the inbound email",
      source: "email_agent",
      status: "in_agent_review",
      assignee: "operator_agent",
      inbound_id: "inbound-1",
      review_kind: "email_triage",
      dedupe_key: "email-triage:inbound-1",
    });

    expect(OPERATOR_ESCALATION_QUEUE).toBe("operator-escalation");
    expect(h.enqueue).toHaveBeenCalledWith({
      queue: "operator-escalation",
      idempotencyKey: "review-1",
      payload: { escalationId: "review-1" },
      maxAttempts: 8,
      db: h.db,
    });
    expect(String(h.query.mock.calls[1]?.[0])).toContain("operator_dispatch_job_id");
    expect(h.audit).toHaveBeenCalledWith(h.db, expect.objectContaining({
      type: "review.operator_triage.queued",
      payload: { escalationId: "review-1", jobId: "job-1" },
    }));
  });
});

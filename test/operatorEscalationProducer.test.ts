import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ createEscalation: vi.fn() }));

vi.mock("../src/core/db/queries/escalations.js", () => ({
  createEscalation: h.createEscalation,
}));
vi.mock("../src/core/db/queries/transactions.js", () => ({
  getTransactionById: vi.fn(),
}));
vi.mock("../src/core/agents/emailAgent/tools/helpers.js", () => ({
  linkInboundToTransaction: vi.fn(),
}));
vi.mock("../src/core/agents/emailAgent/tools/authorization.js", () => ({
  authorizeEmailTransaction: vi.fn(),
}));

import { escalateToOperator } from "../src/core/agents/emailAgent/tools/escalate.js";

beforeEach(() => {
  vi.clearAllMocks();
  h.createEscalation.mockResolvedValue({ id: "review-1" });
});

describe("operator-agent email producer", () => {
  it("creates the sole bounded autonomous state for an exact inbound email", async () => {
    const result = JSON.parse(await escalateToOperator.execute(
      { question: "Can this informational request be answered?" },
      {
        inbound: { id: "inbound-1" },
        serviceId: "service-1",
        serviceSlug: "sample-secondary",
        fromAddress: "support@example.test",
        authorization: { kind: "unauthenticated" },
      } as never,
    ));
    expect(result).toEqual({ ok: true, escalationId: "review-1", assignee: "operator_agent" });
    expect(h.createEscalation).toHaveBeenCalledWith(expect.objectContaining({
      source: "email_agent",
      status: "in_agent_review",
      assignee: "operator_agent",
      inbound_id: "inbound-1",
      review_kind: "email_triage",
      dedupe_key: "email-triage:inbound-1",
      target_type: "email_inbound",
      target_id: "inbound-1",
    }));
  });
});

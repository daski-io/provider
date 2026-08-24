import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEscalationById: vi.fn(),
  loadEscalationContext: vi.fn(),
  closeEscalation: vi.fn(),
  confirmationGate: vi.fn(),
  createServiceRule: vi.fn(),
}));

vi.mock("../src/core/db/queries/escalations.js", () => ({
  countOpenEscalations: vi.fn(),
  getEscalationById: mocks.getEscalationById,
  listOpenEscalations: vi.fn(),
  markEscalationAwaitingHuman: vi.fn(),
  closeEscalation: mocks.closeEscalation,
}));
vi.mock("../src/core/email/postmarkOutbound.js", () => ({ sendEmail: vi.fn() }));
vi.mock("../src/core/events/emitter.js", () => ({ emitEvent: vi.fn() }));
vi.mock("../src/core/agents/operatorAgent/escalationContext.js", () => ({
  loadEscalationContext: mocks.loadEscalationContext,
  summarizeEscalationContext: (value: unknown) => value,
}));
vi.mock("../src/core/agents/operatorAgent/confirmation.js", () => ({
  confirmationGate: mocks.confirmationGate,
  executeConfirmedAction: vi.fn(async (_confirmation, work) => work()),
}));
vi.mock("../src/core/db/queries/serviceRules.js", () => ({
  createServiceRule: mocks.createServiceRule,
  listServiceRules: vi.fn(),
}));

import {
  getEscalationTool,
  replyToBuyerTool,
  resolveEscalationTool,
} from "../src/core/agents/operatorAgent/tools/escalations.js";
import { addServiceRuleTool } from "../src/core/agents/operatorAgent/tools/rules.js";

const humanContext = {
  actor: "0xoperator",
  mode: "human" as const,
  escalationId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  threadId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEscalationById.mockResolvedValue({
    id: humanContext.escalationId,
    source: "pre_execute",
    transaction_id: "task-1",
  });
});

describe("consequential operator surfaces", () => {
  it("keeps protected execution decisions in the deterministic admin workflow", async () => {
    const result = JSON.parse(await resolveEscalationTool.execute(
      { disposition: "replied", reasoning: "Reviewed exact snapshot" },
      humanContext,
    ));
    expect(result).toMatchObject({ ok: false, reason: "email_triage_review_required" });
    expect(mocks.confirmationGate).not.toHaveBeenCalled();
  });

  it("refuses generic closure for a typed review case", async () => {
    mocks.getEscalationById.mockResolvedValue({
      id: humanContext.escalationId,
      source: "screening",
      transaction_id: "task-1",
      review_kind: "screening_adjudication",
      target_type: "screening_check",
      target_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      available_actions: [{ label: "Clear false positive", value: "clear" }],
    });

    const result = JSON.parse(await resolveEscalationTool.execute(
      { disposition: "resolved", reasoning: "Looks fine" },
      humanContext,
    ));

    expect(result).toMatchObject({
      ok: false,
      reason: "email_triage_review_required",
    });
    expect(mocks.closeEscalation).not.toHaveBeenCalled();
  });

  it("scopes autonomous escalation lookup to the current object", async () => {
    mocks.loadEscalationContext.mockResolvedValue({ id: humanContext.escalationId });
    await getEscalationTool.execute(
      { review_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      {
        actor: "operator_agent",
        mode: "autonomous",
        escalationId: humanContext.escalationId,
      },
    );
    expect(mocks.loadEscalationContext).toHaveBeenCalledWith(humanContext.escalationId);
  });

  it("cannot reply from an unbound unauthenticated email escalation", async () => {
    mocks.loadEscalationContext.mockResolvedValue({
      escalation: { source: "email_agent", review_kind: "email_triage" },
      inbound: {
        id: "inbound-1",
        from_address: "attacker@example.net",
        transaction_id: null,
      },
      transaction: null,
      service: { outbound_email_from: "support@example.com" },
    });
    const result = JSON.parse(await replyToBuyerTool.execute(
      { subject: "trusted-looking reply", body: "attacker content" },
      { ...humanContext, actor: "operator_agent", mode: "autonomous" },
    ));
    expect(result).toMatchObject({
      ok: false,
      reason: "authenticated_transaction_required",
    });
    const { sendEmail } = await import("../src/core/email/postmarkOutbound.js");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not persist an LLM prompt rule until its exact intent is approved, then persists the stored text", async () => {
    const args = {
      service_id: "service-1",
      scope: "pre_execute",
      rule: "Escalate every irreversible request.",
    };
    mocks.confirmationGate.mockResolvedValue({
      status: "pending",
      intentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      issued: true,
    });
    const preview = JSON.parse(await addServiceRuleTool.execute(args, humanContext));
    expect(preview.reason).toBe("confirmation_required");
    expect(mocks.createServiceRule).not.toHaveBeenCalled();

    // Approval returns the stored preview text; a drifted retyping must not
    // be what persists.
    mocks.confirmationGate.mockResolvedValue({
      status: "approved",
      payload: { rule: "Escalate every irreversible request." },
    });
    mocks.createServiceRule.mockResolvedValue({ id: "rule-1" });
    const completed = JSON.parse(await addServiceRuleTool.execute(
      { ...args, rule: "Escalate irreversible requests (drifted)." },
      humanContext,
    ));
    expect(completed).toEqual({ ok: true, rule_id: "rule-1" });
    expect(mocks.createServiceRule).toHaveBeenCalledWith(expect.objectContaining({
      rule: "Escalate every irreversible request.",
    }));
  });
});

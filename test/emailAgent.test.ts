import { describe, it, expect, vi, beforeEach } from "vitest";

// Email Agent unit tests. The whole DB layer + OpenAI client are mocked
// so the agent's control flow (tool loop, classification persistence,
// transaction linkage, fail-open) is exercised without Postgres or a real
// model. The OpenAI mock is driven by a scripted sequence of tool calls.

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

vi.mock("../src/core/db/queries/services.js", () => ({ getServiceById: vi.fn() }));
vi.mock("../src/core/db/queries/skills.js", () => ({ getActiveSkillsByServiceId: vi.fn() }));
vi.mock("../src/core/db/queries/serviceRules.js", () => ({ listActiveRulesForLlm: vi.fn() }));
vi.mock("../src/core/db/queries/emails.js", () => ({
  getInboundEmailById: vi.fn(),
  updateInboundEmailClassification: vi.fn(),
  setInboundEmailTransaction: vi.fn(),
}));
vi.mock("../src/core/events/emitter.js", () => ({ emitEvent: vi.fn() }));
vi.mock("../src/core/db/queries/transactions.js", () => ({
  listTransactions: vi.fn(),
  getTransactionById: vi.fn(),
}));
vi.mock("../src/core/db/queries/escalations.js", () => ({ createEscalation: vi.fn() }));
vi.mock("../src/core/db/queries/payments.js", () => ({
  getSettlementByTransaction: vi.fn(),
}));
vi.mock("../src/core/email/postmarkOutbound.js", () => ({ sendEmail: vi.fn() }));

import { processInboundEmail } from "../src/core/agents/emailAgent/index.js";
import { SHARED_TOOLS as TOOLS } from "../src/core/agents/emailAgent/tools/index.js";
import { getServiceById } from "../src/core/db/queries/services.js";
import { getActiveSkillsByServiceId } from "../src/core/db/queries/skills.js";
import { listActiveRulesForLlm } from "../src/core/db/queries/serviceRules.js";
import {
  getInboundEmailById,
  updateInboundEmailClassification,
  setInboundEmailTransaction,
} from "../src/core/db/queries/emails.js";
import { getTransactionById, listTransactions } from "../src/core/db/queries/transactions.js";

// Minimal row shapes — only the fields the agent reads matter, so these
// are intentionally partial and typed loosely.
/* eslint-disable @typescript-eslint/no-explicit-any */
const inbound: any = {
  id: "inbound-1",
  message_id: "<msg-1@host>",
  from_address: "buyer@example.com",
  to_address: "support@svc.example.com",
  subject: "Is my item ready?",
  body_text: "Hi, did example.com go through?",
  body_html: null,
  headers: {},
  in_reply_to: null,
  thread_root: null,
  buyer_id: null,
  service_id: "svc-1",
  transaction_id: null,
  classification: null,
  classification_reason: null,
  received_at: new Date("2026-06-01T00:00:00Z"),
};
const service: any = {
  id: "svc-1",
  name: "Sample Service",
  slug: "dummy",
  version: "1",
  service_description: "Create and manage sample items.",
  outbound_email_from: "support@svc.example.com",
  inbound_email_address: "support@svc.example.com",
  is_active: true,
};
const tx: any = { id: "tx-1", service_id: "svc-1", buyer_id: "buyer-1", contact_email: "buyer@example.com" };

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
function assistantTurn(calls: ReturnType<typeof toolCall>[]) {
  return { choices: [{ message: { content: null, tool_calls: calls } }] };
}

beforeEach(() => {
  // resetAllMocks (not clear) so any scripted *Once queue on createMock
  // from a prior test can't leak into the next one.
  vi.resetAllMocks();
  // Fresh copy of inbound state per test (the agent mutates ctx.inbound).
  inbound.transaction_id = null;
  inbound.buyer_id = null;
  vi.mocked(getInboundEmailById).mockResolvedValue({ ...inbound });
  vi.mocked(getServiceById).mockResolvedValue(service);
  vi.mocked(getActiveSkillsByServiceId).mockResolvedValue([] as any);
  vi.mocked(listActiveRulesForLlm).mockResolvedValue([] as any);
  vi.mocked(listTransactions).mockResolvedValue([] as any);
  vi.mocked(getTransactionById).mockResolvedValue(tx);
  vi.mocked(updateInboundEmailClassification).mockResolvedValue(undefined as any);
  vi.mocked(setInboundEmailTransaction).mockResolvedValue(undefined as any);
});

describe("Email Agent tool surface (authority bounds)", () => {
  const names = TOOLS.map((t) => t.definition.function.name);

  it("exposes exactly the bounded triage tools", () => {
    expect(new Set(names)).toEqual(
      new Set([
        "classify",
        "reply_to_sender",
        "escalate_to_operator",
      ]),
    );
  });

  it("exposes no refund, forwarding, discovery, or linking authority", () => {
    for (const n of names) {
      expect(n).not.toMatch(/refund|forward|find|link/i);
    }
  });

  it("exposes NO rule-writing tool (only the Operator Agent mutates rules)", () => {
    for (const n of names) {
      expect(n).not.toMatch(/rule/i);
    }
  });
});

describe("processInboundEmail", () => {
  it("does not execute model-requested private lookup/link tools", async () => {
    createMock
      .mockResolvedValueOnce(
        assistantTurn([toolCall("c1", "find_transaction", { search_text: "example.com" })]),
      )
      .mockResolvedValueOnce(
        assistantTurn([
          toolCall("c2", "link_transaction", { transaction_id: "tx-1" }),
          toolCall("c3", "classify", { classification: "question", reason: "buyer asked status" }),
        ]),
      );

    await processInboundEmail("inbound-1");

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(setInboundEmailTransaction).not.toHaveBeenCalled();
    expect(updateInboundEmailClassification).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inbound-1", classification: "question" }),
    );
  });

  it("fails open to 'unknown' when the model never classifies", async () => {
    // Always return a non-classify tool call → the loop hits its cap.
    createMock.mockResolvedValue(
      assistantTurn([toolCall("c", "find_transaction", { search_text: "x" })]),
    );

    await processInboundEmail("inbound-1");

    expect(updateInboundEmailClassification).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inbound-1", classification: "unknown" }),
    );
  });

  it("skips emails already classified", async () => {
    vi.mocked(getInboundEmailById).mockResolvedValue({ ...inbound, classification: "informational" });
    await processInboundEmail("inbound-1");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("redacts and bounds untrusted PII from a claimed private thread", async () => {
    vi.mocked(getInboundEmailById).mockResolvedValue({
      ...inbound,
      thread_root: "<victim-thread@example.com>",
      subject: "SSN 078-05-1120 for victim@example.com",
      body_text:
        "DOB 1990-01-02, phone 303-555-1212, email victim@example.com, " +
        "address 123 Victim Street, URL https://evil.example/private?token=secret, " +
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    });
    createMock.mockResolvedValueOnce(
      assistantTurn([
        toolCall("c1", "classify", {
          classification: "question",
          reason: "private status request",
        }),
      ]),
    );

    await processInboundEmail("inbound-1");

    const request = createMock.mock.calls[0]![0] as {
      messages: Array<{ content: string }>;
    };
    const prompt = request.messages[0]!.content;
    expect(prompt).not.toContain("078-05-1120");
    expect(prompt).not.toContain("victim@example.com");
    expect(prompt).not.toContain("303-555-1212");
    expect(prompt).not.toContain("123 Victim Street");
    expect(prompt).not.toContain("https://evil.example");
    expect(prompt).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(prompt).toContain("<redacted:ssn>");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emitEvent: vi.fn(),
  enqueueEmailIngress: vi.fn(),
  findInboundInterceptor: vi.fn(),
  getServiceByInboundEmail: vi.fn(),
  insertInboundEmail: vi.fn(),
  requeueFailedEmailIngress: vi.fn(),
  shouldAutoFilter: vi.fn(),
  updateInboundEmailClassification: vi.fn(),
  updateInboundProcessing: vi.fn(),
}));

vi.mock("../src/core/db/queries/emails.js", () => ({
  insertInboundEmail: mocks.insertInboundEmail,
  updateInboundEmailClassification: mocks.updateInboundEmailClassification,
  updateInboundProcessing: mocks.updateInboundProcessing,
}));
vi.mock("../src/core/db/queries/services.js", () => ({
  getServiceByInboundEmail: mocks.getServiceByInboundEmail,
}));
vi.mock("../src/core/events/emitter.js", () => ({
  emitEvent: mocks.emitEvent,
}));
vi.mock("../src/core/email/preFilter.js", () => ({
  shouldAutoFilter: mocks.shouldAutoFilter,
}));
vi.mock("../src/core/email/postmarkIngressQueue.js", () => ({
  enqueueEmailIngress: mocks.enqueueEmailIngress,
  requeueFailedEmailIngress: mocks.requeueFailedEmailIngress,
}));
vi.mock("../src/core/email/postmarkRouting.js", () => ({
  findInboundInterceptor: mocks.findInboundInterceptor,
}));

import { processPostmarkInbound } from "../src/core/email/postmarkInboundProcessing.js";

const passingHeaders = [
  { Name: "Received-SPF", Value: "pass (sender authorized)" },
  {
    Name: "X-Spam-Tests",
    Value: "DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,SPF_PASS",
  },
  { Name: "X-Spam-Status", Value: "No" },
  { Name: "X-Spam-Score", Value: "0" },
];

function payload(Headers: Array<{ Name: string; Value: string }> = passingHeaders) {
  return {
    MessageID: "postmark-message-1",
    From: "sender@vendor.example",
    To: "intake@example.com",
    Subject: "Documents",
    TextBody: "Please provide documents.",
    Headers,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findInboundInterceptor.mockResolvedValue({
    failed: false,
    interceptor: null,
  });
  mocks.getServiceByInboundEmail.mockResolvedValue({
    id: "service-1",
    slug: "example-service",
  });
  mocks.shouldAutoFilter.mockResolvedValue({ filter: false, reason: null });
  mocks.insertInboundEmail.mockImplementation(
    async (args: Record<string, unknown>) => ({
      row: { id: "inbound-1", ...args },
      inserted: true,
    }),
  );
});

describe("Postmark inbound processing boundary", () => {
  it("rejects malformed optional fields and headers before routing", async () => {
    const malformedSubject = await processPostmarkInbound({
      ...payload(),
      Subject: { unexpected: true },
    });
    expect(malformedSubject).toEqual({
      status: 400,
      body: { ok: false, reason: "invalid_payload" },
    });

    const malformedHeaders = await processPostmarkInbound({
      ...payload(),
      Headers: [{ Name: "X-Spam-Score", Value: 0 }],
    });
    expect(malformedHeaders).toEqual({
      status: 400,
      body: { ok: false, reason: "invalid_payload" },
    });
    expect(mocks.findInboundInterceptor).not.toHaveBeenCalled();
  });

  it("persists complete sender and spam verdicts at ingress", async () => {
    const result = await processPostmarkInbound(payload());

    expect(result.status).toBe(200);
    expect(mocks.insertInboundEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        postmark_sender_authenticated: true,
        postmark_spam_safe: true,
      }),
    );
    expect(mocks.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Inbound email accepted for processing.",
      }),
    );
  });

  it("does not treat raw Authentication-Results as sender authentication", async () => {
    const result = await processPostmarkInbound(payload([{
      Name: "Authentication-Results",
      Value: "attacker.example; spf=pass; dkim=pass; dmarc=pass",
    }]));

    expect(result.status).toBe(200);
    expect(mocks.insertInboundEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        postmark_sender_authenticated: false,
        postmark_spam_safe: false,
      }),
    );
  });

  it("bounds the original recipient before routing", async () => {
    const result = await processPostmarkInbound({
      ...payload(),
      OriginalRecipient: "a".repeat(2_049),
    });

    expect(result).toEqual({
      status: 413,
      body: { ok: false, reason: "message_too_large" },
    });
    expect(mocks.findInboundInterceptor).not.toHaveBeenCalled();
  });
});

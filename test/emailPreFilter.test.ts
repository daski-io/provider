import { describe, it, expect, vi, beforeEach } from "vitest";

// The pre-LLM filter calls countOutboundInThreadSince (DB) only on the
// thread-reply-cap path; mock the query module so the suite runs without
// Postgres.
vi.mock("../src/core/db/queries/emails.js", () => ({
  countOutboundInThreadSince: vi.fn(),
}));

import { countOutboundInThreadSince } from "../src/core/db/queries/emails.js";
import { shouldAutoFilter } from "../src/core/email/preFilter.js";

const mockCount = vi.mocked(countOutboundInThreadSince);

describe("shouldAutoFilter", () => {
  beforeEach(() => {
    mockCount.mockReset();
    mockCount.mockResolvedValue(0);
  });

  it("passes an ordinary human email through", async () => {
    const d = await shouldAutoFilter({
      Headers: [{ Name: "From", Value: "buyer@example.com" }],
      Subject: "Question about my item",
    });
    expect(d.filter).toBe(false);
  });

  it("filters Auto-Submitted (not 'no')", async () => {
    const d = await shouldAutoFilter({
      Headers: [{ Name: "Auto-Submitted", Value: "auto-replied" }],
      Subject: "Re: your message",
    });
    expect(d.filter).toBe(true);
  });

  it("does NOT filter Auto-Submitted: no", async () => {
    const d = await shouldAutoFilter({
      Headers: [{ Name: "Auto-Submitted", Value: "no" }],
      Subject: "A real reply",
    });
    expect(d.filter).toBe(false);
  });

  it("filters bulk Precedence", async () => {
    const d = await shouldAutoFilter({
      Headers: [{ Name: "Precedence", Value: "bulk" }],
      Subject: "Newsletter",
    });
    expect(d.filter).toBe(true);
  });

  it("filters list mail (List-Unsubscribe present)", async () => {
    const d = await shouldAutoFilter({
      Headers: [{ Name: "List-Unsubscribe", Value: "<mailto:x@y>" }],
      Subject: "Promo",
    });
    expect(d.filter).toBe(true);
  });

  it("filters out-of-office subjects", async () => {
    for (const subject of ["Out of office", "Automatic reply: away", "OOO until Monday"]) {
      const d = await shouldAutoFilter({ Headers: [], Subject: subject });
      expect(d.filter, subject).toBe(true);
    }
  });

  it("filters on Postmark's X-Spam-Status: Yes verdict", async () => {
    const d = await shouldAutoFilter({
      Headers: [{ Name: "X-Spam-Status", Value: "Yes, score=8.1 required=5.0" }],
      Subject: "CHEAP MEDS",
    });
    expect(d.filter).toBe(true);
  });

  it("does NOT filter X-Spam-Status: No", async () => {
    const d = await shouldAutoFilter({
      Headers: [{ Name: "X-Spam-Status", Value: "No, score=-0.5 required=5.0" }],
      Subject: "Question about my item",
    });
    expect(d.filter).toBe(false);
  });

  it("filters on a high X-Spam-Score", async () => {
    const d = await shouldAutoFilter({
      Headers: [{ Name: "X-Spam-Score", Value: "6.4" }],
      Subject: "hello",
    });
    expect(d.filter).toBe(true);
  });

  it("does NOT filter a low X-Spam-Score", async () => {
    const d = await shouldAutoFilter({
      Headers: [{ Name: "X-Spam-Score", Value: "1.2" }],
      Subject: "hello",
    });
    expect(d.filter).toBe(false);
  });

  it("filters when the thread reply cap is hit", async () => {
    mockCount.mockResolvedValue(3);
    const d = await shouldAutoFilter({
      Headers: [],
      Subject: "Still chatting",
      threadRoot: "<root@host>",
    });
    expect(d.filter).toBe(true);
    expect(mockCount).toHaveBeenCalledOnce();
  });

  it("does not filter below the thread reply cap", async () => {
    mockCount.mockResolvedValue(2);
    const d = await shouldAutoFilter({
      Headers: [],
      Subject: "Still chatting",
      threadRoot: "<root@host>",
    });
    expect(d.filter).toBe(false);
  });
});

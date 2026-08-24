import { describe, expect, it } from "vitest";
import type { ChatThreadRow } from "../src/core/db/queries/chatThreads.js";
import { canAccessChatThread } from "../src/core/admin/ui/pages/chat/access.js";

function thread(overrides: Partial<ChatThreadRow>): ChatThreadRow {
  return {
    id: "thread-1",
    wallet_address: null,
    escalation_id: null,
    title: null,
    status: "open",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe("operator chat thread access", () => {
  it("restricts a free-form thread to its SIWE wallet", () => {
    const freeForm = thread({ wallet_address: "0xAa" });

    expect(canAccessChatThread(freeForm, "0xaa")).toBe(true);
    expect(canAccessChatThread(freeForm, "0xbb")).toBe(false);
  });

  it("keeps escalation threads shared between authenticated operators", () => {
    const escalation = thread({
      escalation_id: "escalation-1",
      wallet_address: "0xaa",
    });

    expect(canAccessChatThread(escalation, "0xbb")).toBe(true);
  });
});

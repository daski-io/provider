import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/config.js", () => ({
  config: { ADMIN_TOKEN: "test-admin-token-0123456789abcdef" },
}));

import {
  confirmationCsrfToken,
  validConfirmationCsrfToken,
} from "../src/core/admin/ui/csrf.js";

const binding = {
  sessionId: "session-1",
  wallet: "0xAbCd",
  threadId: "thread-1",
};

describe("browser confirmation CSRF", () => {
  it("derives a stable opaque token without exposing the configured secret", () => {
    const token = confirmationCsrfToken(binding);
    expect(token).not.toContain("test-admin-token-0123456789abcdef");
    expect(validConfirmationCsrfToken(token, binding)).toBe(true);
  });

  it("binds confirmation to session, wallet, and thread", () => {
    const token = confirmationCsrfToken(binding);
    expect(validConfirmationCsrfToken(token, { ...binding, sessionId: "other" })).toBe(false);
    expect(validConfirmationCsrfToken(token, { ...binding, wallet: "0x1234" })).toBe(false);
    expect(validConfirmationCsrfToken(token, { ...binding, threadId: "other" })).toBe(false);
    expect(validConfirmationCsrfToken("", binding)).toBe(false);
  });
});

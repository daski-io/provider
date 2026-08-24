import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveSession: vi.fn(),
  revokeAllSessions: vi.fn(),
  isWalletAllowed: vi.fn(),
}));
vi.mock("../src/core/db/queries/sessions.js", () => ({
  getActiveSession: mocks.getActiveSession,
  revokeAllSessions: mocks.revokeAllSessions,
}));
vi.mock("../src/core/auth/siwe.js", () => ({
  isWalletAllowed: mocks.isWalletAllowed,
}));

import { authorizeAdminUiSession } from "../src/core/admin/ui/sessionAuth.js";

const session = {
  id: "session-1",
  token_hash: Buffer.alloc(32),
  user_label: "0xremoved",
  created_at: new Date(),
  expires_at: new Date(Date.now() + 60_000),
  last_seen_at: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getActiveSession.mockResolvedValue(session);
});

describe("admin UI session authorization", () => {
  it("accepts a live session only while its wallet remains allowlisted", async () => {
    mocks.isWalletAllowed.mockReturnValue(true);
    expect(await authorizeAdminUiSession("opaque-bearer")).toBe(session);
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });

  it("immediately revokes every session after allowlist removal", async () => {
    mocks.isWalletAllowed.mockReturnValue(false);
    expect(await authorizeAdminUiSession("opaque-bearer")).toBeNull();
    expect(mocks.revokeAllSessions).toHaveBeenCalledWith("0xremoved");
  });
});

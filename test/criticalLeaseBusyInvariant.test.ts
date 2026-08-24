import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/db/sessionAdvisoryLock.js", () => ({
  withSessionAdvisoryLock: vi.fn(async () => ({ status: "busy" })),
}));
vi.mock("../src/core/db/pool.js", () => ({
  pool: { connect: vi.fn() },
}));

import { withProviderSignerLease } from "../src/core/chain/signerLease.js";
import { withComplianceRefundLease } from "../src/core/compliance/lease.js";

describe("lease wrapper guard invariants", () => {
  it("retains the signer timeout contract for a busy guard result", async () => {
    await expect(withProviderSignerLease({
      chainId: 8453,
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
    }, async () => undefined)).rejects.toThrow(/timed out/i);
  });

  it("rejects the unreachable compliance busy state", async () => {
    await expect(
      withComplianceRefundLease(async () => undefined),
    ).rejects.toThrow(/unexpectedly reported busy/i);
  });
});

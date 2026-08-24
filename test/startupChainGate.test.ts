import { describe, expect, it, vi } from "vitest";
import { enforceInitialChainReadiness } from "../src/core/startupChainGate.js";

function dependencies(patch: Record<string, unknown> = {}) {
  return {
    verifyChainTrust: vi.fn(async () => undefined),
    verifyIdentity: vi.fn(async () => true),
    markIdentityVerified: vi.fn(),
    reconcileRegistrations: vi.fn(async () => ({
      registered: 1,
      already_on_chain: 2,
      skipped_missing_data: 0,
    })),
    registrationHealth: vi.fn(() => ({
      ok: true,
      checkedAt: new Date("2026-07-29T00:00:00Z"),
      error: null,
    })),
    ...patch,
  };
}

describe("initial chain readiness gate", () => {
  it("aborts before identity or registration when chain trust is not proven", async () => {
    const deps = dependencies({
      verifyChainTrust: vi.fn(async () => {
        throw new Error("RPC chain id mismatch");
      }),
    });
    await expect(enforceInitialChainReadiness(deps))
      .rejects.toThrow("RPC chain id mismatch");
    expect(deps.verifyIdentity).not.toHaveBeenCalled();
    expect(deps.reconcileRegistrations).not.toHaveBeenCalled();
  });

  it("aborts before registration when provider identity is wrong", async () => {
    const deps = dependencies({
      verifyIdentity: vi.fn(async () => false),
    });
    await expect(enforceInitialChainReadiness(deps))
      .rejects.toThrow("Provider wallet does not match");
    expect(deps.reconcileRegistrations).not.toHaveBeenCalled();
    expect(deps.markIdentityVerified).not.toHaveBeenCalled();
  });

  it("aborts when initial registration reconciliation is unhealthy", async () => {
    const deps = dependencies({
      registrationHealth: vi.fn(() => ({
        ok: false,
        checkedAt: null,
        error: "controlled registration failure",
      })),
    });
    await expect(enforceInitialChainReadiness(deps))
      .rejects.toThrow("controlled registration failure");
    expect(deps.markIdentityVerified).toHaveBeenCalledWith(true);
  });

  it("returns only after identity and registration are proven", async () => {
    const deps = dependencies();
    await expect(enforceInitialChainReadiness(deps)).resolves.toMatchObject({
      reconciliation: { registered: 1 },
      checkedAt: new Date("2026-07-29T00:00:00Z"),
    });
    expect(deps.verifyChainTrust).toHaveBeenCalledOnce();
  });
});

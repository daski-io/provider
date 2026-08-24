import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  agentWallet: "0x1111111111111111111111111111111111111111",
}));

vi.mock("../src/core/config.js", () => ({
  config: {
    PROVIDER_AGENT_ID: 7n,
    IDENTITY_REGISTRY_ADDRESS:
      "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
    REGISTRATION_RECONCILE_MAX_AGE_SECONDS: 300,
  },
}));

vi.mock("../src/core/chain/client.js", () => ({
  CHAIN_MODE_MOCK: false,
  providerAddress: "0x1111111111111111111111111111111111111111",
  publicClient: {
    readContract: vi.fn(async () => state.agentWallet),
  },
}));

vi.mock("../src/core/logger.js", () => ({
  errorExtra: vi.fn((_error: unknown, extra: Record<string, unknown>) => extra),
  logWarn: vi.fn(),
}));

import {
  getProviderIdentityAuthorization,
  recordProviderIdentityVerification,
  refreshProviderIdentityAuthorization,
} from "../src/core/chain/providerIdentity.js";

beforeEach(() => {
  state.agentWallet = "0x1111111111111111111111111111111111111111";
  recordProviderIdentityVerification(false, new Date(0));
});

describe("provider identity authorization", () => {
  it("expires at the service-registration reconciliation age", () => {
    const checkedAt = new Date("2026-07-30T12:00:00Z");
    recordProviderIdentityVerification(true, checkedAt);
    expect(
      getProviderIdentityAuthorization(checkedAt.getTime() + 299_999).ok,
    ).toBe(true);
    expect(
      getProviderIdentityAuthorization(checkedAt.getTime() + 300_001),
    ).toMatchObject({
      ok: false,
      reason: "provider identity verification is stale",
    });
  });

  it("revokes authorization after the on-chain agent wallet changes", async () => {
    await expect(refreshProviderIdentityAuthorization()).resolves.toBe(true);
    expect(getProviderIdentityAuthorization().ok).toBe(true);

    state.agentWallet = "0x2222222222222222222222222222222222222222";
    await expect(refreshProviderIdentityAuthorization()).resolves.toBe(false);
    expect(getProviderIdentityAuthorization()).toMatchObject({
      ok: false,
      reason: "provider identity is not verified",
    });
  });

  it("fails closed when the identity registry cannot be read", async () => {
    recordProviderIdentityVerification(true);
    await expect(
      refreshProviderIdentityAuthorization(async () => {
        throw new Error("controlled RPC outage");
      }),
    ).resolves.toBe(false);
    expect(getProviderIdentityAuthorization().ok).toBe(false);
  });
});

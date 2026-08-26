import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { assertActivationCheckpoint, type ActivationObservation } from
  "../src/core/standardRail/evidenceCheckpoint.js";
import type { ProviderOutcomeConfig } from "../src/core/standardRail/types.js";
import { standardSplitterFixture } from "./standardRailOutcomeFixture.js";

const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;

function outcome(): ProviderOutcomeConfig {
  return {
    ...standardSplitterFixture(),
    outcomeId: "dummy-create-note", serviceSlug: "dummy", serviceId: hash("0"), skillId: "create-note",
    listingManifestHash: hash("1"), providerOfferHash: hash("2"), pricingMode: "fixed",
    fixedGrossAmount: "10000", quoteMaximumLifetimeSeconds: 0, quoteMinimumPaymentWindowSeconds: 0,
    providerControlProfileHash: hash("3"), activeRailProfileHash: hash("9"),
    customerIdentityPolicyId: "none", tokenRuntimeCodeHash: hash("5"),
    tokenImplementationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    tokenImplementationRuntimeCodeHash: hash("a"), tokenImplementationSlot: hash("b"),
    tokenDomainSeparator: hash("c"), sanctionsOracleRuntimeCodeHash: hash("d"),
    providerControlledWallets: [], maximumSourceLagBlocks: 3, maximumLogPageEvents: 10_000,
    listingCommitmentHash: hash("6"), outcomeIdHash: hash("7"), policyVersionHash: hash("8"),
    listingEpoch: "1", providerTerminalAttestationKey: "0x4444444444444444444444444444444444444444",
    commissionBps: 500, maxOpenOrders: 10, dispatchDeadlineSeconds: 300, bindingProfile: "recipe-bound-v1",
    requestSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}

function observation(config: ProviderOutcomeConfig): ActivationObservation {
  return {
    blockNumber: config.splitterActivationBlockNumber,
    blockHash: config.splitterActivationBlockHash,
    position: "END_OF_BLOCK",
    tokenBalance: config.splitterStartingTokenBalance,
    releaseSequence: config.splitterStartingReleaseSequence,
    tokenCodeHash: config.tokenRuntimeCodeHash,
    splitterCodeHash: config.splitterRuntimeCodeHash,
    factoryCodeHash: config.splitterFactoryRuntimeCodeHash,
  };
}

describe("activation checkpoint evidence", () => {
  it("rejects a block-hash mismatch after a reorg", () => {
    const config = outcome();
    expect(() => assertActivationCheckpoint(config, {
      ...observation(config),
      blockHash: hash("f"),
    })).toThrow("Splitter activation checkpoint mismatch");
  });

  it("rebuilds the same result statelessly after restart", () => {
    const config = outcome();
    const first = assertActivationCheckpoint(config, observation(config));
    const rebuilt = assertActivationCheckpoint({ ...config }, observation({ ...config }));
    expect(rebuilt).toEqual(first);
  });
});

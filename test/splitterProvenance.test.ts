import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  assertSplitterDeploymentProvenance,
  expectedSplitterDeploymentInput,
  type SplitterDeploymentObservation,
} from "../src/core/standardRail/splitterProvenance.js";
import type { ProviderOutcomeConfig } from "../src/core/standardRail/types.js";
import { standardSplitterFixture } from "./standardRailOutcomeFixture.js";

const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;

function outcome(): ProviderOutcomeConfig {
  return {
    ...standardSplitterFixture(),
    outcomeId: "dummy-create-note",
    serviceSlug: "dummy",
    serviceId: hash("0"),
    skillId: "dummy-create-note",
    listingManifestHash: hash("1"),
    providerOfferHash: hash("2"),
    pricingMode: "fixed",
    fixedGrossAmount: "10000",
    quoteMaximumLifetimeSeconds: 0,
    quoteMinimumPaymentWindowSeconds: 0,
    providerControlProfileHash: hash("3"),
    activeRailProfileHash: hash("9"),
    customerIdentityPolicyId: "none",
    tokenRuntimeCodeHash: hash("5"),
    tokenImplementationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    tokenImplementationRuntimeCodeHash: hash("a"),
    tokenImplementationSlot: hash("b"),
    tokenDomainSeparator: hash("c"),
    sanctionsOracleRuntimeCodeHash: hash("d"),
    providerControlledWallets: [],
    maximumSourceLagBlocks: 3,
    maximumLogPageEvents: 10_000,
    listingCommitmentHash: hash("6"),
    outcomeIdHash: hash("7"),
    policyVersionHash: hash("8"),
    listingEpoch: "1",
    providerTerminalAttestationKey: "0x4444444444444444444444444444444444444444",
    commissionBps: 500,
    maxOpenOrders: 10,
    dispatchDeadlineSeconds: 300,
    bindingProfile: "recipe-bound-v1",
    requestSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}

function observation(config: ProviderOutcomeConfig): SplitterDeploymentObservation {
  return {
    receiptStatus: "success",
    receiptTransactionHash: config.splitterDeploymentTransaction,
    receiptBlockNumber: BigInt(config.splitterDeploymentBlockNumber),
    receiptBlockHash: config.splitterDeploymentBlockHash,
    transactionHash: config.splitterDeploymentTransaction,
    transactionTo: config.splitterFactory,
    transactionValue: 0n,
    transactionInput: expectedSplitterDeploymentInput(config, 84532),
    transactionBlockNumber: BigInt(config.splitterDeploymentBlockNumber),
    transactionBlockHash: config.splitterDeploymentBlockHash,
    factoryRuntimeCodeHash: config.splitterFactoryRuntimeCodeHash,
    splitterRuntimeCodeHash: config.splitterRuntimeCodeHash,
    events: [{
      emitter: config.splitterFactory,
      splitter: config.splitter,
      salt: config.splitterDeploymentSalt,
      outcomeIdHash: config.outcomeIdHash,
      listingEpoch: BigInt(config.listingEpoch),
      listingCommitmentHash: config.listingCommitmentHash,
    }],
    immutables: {
      canonicalChainId: 84532n,
      canonicalToken: config.token,
      providerPayee: config.providerPayee,
      daskiCommissionReceiver: config.daskiCommissionReceiver,
      commissionBps: config.commissionBps,
      policyVersionHash: config.policyVersionHash,
      outcomeIdHash: config.outcomeIdHash,
      listingCommitmentHash: config.listingCommitmentHash,
      listingEpoch: BigInt(config.listingEpoch),
    },
  };
}

describe("splitter deployment provenance", () => {
  it("accepts a locally derived CREATE2 deployment with matching factory evidence", () => {
    const config = outcome();
    expect(assertSplitterDeploymentProvenance(config, 84532, observation(config)))
      .toEqual(observation(config));
  });

  it("rejects a self-consistent event from a factory with different runtime code", () => {
    const config = outcome();
    expect(() => assertSplitterDeploymentProvenance(config, 84532, {
      ...observation(config),
      factoryRuntimeCodeHash: hash("f"),
    })).toThrow("Splitter factory deployment provenance mismatch");
  });

  it("rejects factory calldata that does not encode the reviewed constructor arguments", () => {
    const config = outcome();
    expect(() => assertSplitterDeploymentProvenance(config, 84532, {
      ...observation(config),
      transactionInput: "0x1234",
    })).toThrow("Splitter factory deployment provenance mismatch");
  });
});

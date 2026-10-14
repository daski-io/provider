import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  getCreate2Address,
  keccak256,
  type Hex,
} from "viem";
import { assertExactKeys } from "./canonical.js";
import type { ProviderOutcomeConfig } from "./types.js";

const bytes32 = (value: string, name: string): Hex => {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${name} must be bytes32`);
  return normalized as Hex;
};

/**
 * The fail-closed shape and provenance check every materialized listing
 * version passes before it is sold or serviced: exact keys, fixed one-shot
 * pricing, hashes and addresses, the activation checkpoint, the splitter's
 * CREATE2 provenance, and bounded policy values.
 */
export function validateOutcome(outcome: ProviderOutcomeConfig, chainId: number): void {
  assertExactKeys(outcome, [
    "outcomeId", "serviceSlug", "serviceId", "skillId", "listingManifestHash", "providerOfferHash",
    "pricingMode", "fixedGrossAmount", "quoteMaximumLifetimeSeconds",
    "quoteMinimumPaymentWindowSeconds", "providerControlProfileHash", "activeRailProfileHash",
    "customerIdentityPolicyId", "token", "splitter", "splitterRuntimeCodeHash",
    "splitterFactory", "splitterFactoryRuntimeCodeHash", "splitterCreationCode",
    "splitterCreationCodeHash", "splitterInitCodeHash", "splitterDeploymentSalt",
    "splitterDeploymentTransaction", "splitterDeploymentBlockNumber",
    "splitterDeploymentBlockHash", "splitterActivationBlockNumber",
    "splitterActivationBlockHash", "splitterActivationPosition",
    "splitterStartingTokenBalance", "splitterStartingReleaseSequence", "tokenRuntimeCodeHash",
    "tokenImplementationAddress", "tokenImplementationRuntimeCodeHash", "tokenImplementationSlot",
    "tokenDomainSeparator", "sanctionsOracleRuntimeCodeHash", "providerControlledWallets",
    "maximumSourceLagBlocks", "maximumLogPageEvents", "listingCommitmentHash", "outcomeIdHash",
    "policyVersionHash", "listingEpoch", "providerPayee", "providerTerminalAttestationKey",
    "daskiCommissionReceiver", "commissionBps", "maxOpenOrders", "dispatchDeadlineSeconds",
    "fulfillmentSeconds", "bindingProfile", "requestSchema", "resultSchema",
  ], `outcome ${outcome.outcomeId}`);
  if (
    !outcome.outcomeId || !outcome.serviceSlug || !outcome.skillId
    || outcome.pricingMode !== "fixed"
    || !/^[1-9]\d*$/.test(outcome.fixedGrossAmount)
    || outcome.quoteMaximumLifetimeSeconds !== 0
    || outcome.quoteMinimumPaymentWindowSeconds !== 0
    || outcome.customerIdentityPolicyId !== "none"
  ) throw new Error(`Outcome ${outcome.outcomeId} must use fixed one-shot pricing`);

  const hexFields = [
    "serviceId", "listingManifestHash", "providerOfferHash", "providerControlProfileHash",
    "activeRailProfileHash", "splitterFactoryRuntimeCodeHash", "splitterCreationCodeHash",
    "splitterInitCodeHash", "splitterDeploymentSalt", "splitterRuntimeCodeHash",
    "splitterDeploymentTransaction", "splitterDeploymentBlockHash",
    "splitterActivationBlockHash", "tokenRuntimeCodeHash",
    "tokenImplementationRuntimeCodeHash", "tokenImplementationSlot", "tokenDomainSeparator",
    "sanctionsOracleRuntimeCodeHash", "listingCommitmentHash", "outcomeIdHash",
    "policyVersionHash",
  ] as const;
  for (const field of hexFields) bytes32(outcome[field], `${outcome.outcomeId}.${field}`);
  for (const field of [
    "token", "tokenImplementationAddress", "splitter", "splitterFactory", "providerPayee",
    "providerTerminalAttestationKey", "daskiCommissionReceiver",
  ] as const) getAddress(outcome[field]);
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(outcome.splitterCreationCode)) {
    throw new Error(`Outcome ${outcome.outcomeId} splitter creation code is invalid`);
  }
  if (
    !/^\d+$/.test(outcome.listingEpoch)
    || !/^\d+$/.test(outcome.splitterDeploymentBlockNumber)
    || !/^\d+$/.test(outcome.splitterActivationBlockNumber)
    || !/^\d+$/.test(outcome.splitterStartingTokenBalance)
    || !/^\d+$/.test(outcome.splitterStartingReleaseSequence)
    || BigInt(outcome.listingEpoch) === 0n
    || BigInt(outcome.listingEpoch) >= 1n << 64n
    || BigInt(outcome.splitterActivationBlockNumber)
      < BigInt(outcome.splitterDeploymentBlockNumber)
    || BigInt(outcome.splitterStartingReleaseSequence) >= 1n << 64n
    || BigInt(outcome.splitterStartingTokenBalance) >= 1n << 256n
    || outcome.splitterActivationPosition !== "END_OF_BLOCK"
  ) throw new Error(`Outcome ${outcome.outcomeId} activation checkpoint is invalid`);

  const constructorArgs = encodeAbiParameters(
    [
      { type: "uint256" }, { type: "address" }, { type: "address" },
      { type: "address" }, { type: "uint16" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" },
    ],
    [
      BigInt(chainId), getAddress(outcome.token), getAddress(outcome.providerPayee),
      getAddress(outcome.daskiCommissionReceiver), outcome.commissionBps,
      outcome.policyVersionHash, outcome.outcomeIdHash, outcome.listingCommitmentHash,
      BigInt(outcome.listingEpoch),
    ],
  );
  const creationCodeHash = keccak256(outcome.splitterCreationCode);
  const initCodeHash = keccak256(concatHex([outcome.splitterCreationCode, constructorArgs]));
  if (
    creationCodeHash.toLowerCase() !== outcome.splitterCreationCodeHash.toLowerCase()
    || initCodeHash.toLowerCase() !== outcome.splitterInitCodeHash.toLowerCase()
    || getCreate2Address({
      from: getAddress(outcome.splitterFactory),
      salt: outcome.splitterDeploymentSalt,
      bytecodeHash: initCodeHash,
    }) !== getAddress(outcome.splitter)
  ) throw new Error(`Outcome ${outcome.outcomeId} splitter provenance is invalid`);

  if (
    !Array.isArray(outcome.providerControlledWallets)
    || outcome.providerControlledWallets.some((value) => !/^0x[0-9a-fA-F]{40}$/.test(value))
    || new Set(outcome.providerControlledWallets.map((value) =>
      getAddress(value).toLowerCase())).size !== outcome.providerControlledWallets.length
    || !Number.isSafeInteger(outcome.commissionBps)
    || outcome.commissionBps <= 0 || outcome.commissionBps >= 10_000
    || !Number.isSafeInteger(outcome.maxOpenOrders) || outcome.maxOpenOrders < 1
    || !Number.isSafeInteger(outcome.maximumSourceLagBlocks) || outcome.maximumSourceLagBlocks < 0
    || !Number.isSafeInteger(outcome.maximumLogPageEvents)
    || outcome.maximumLogPageEvents < 1 || outcome.maximumLogPageEvents > 100_000
    || !Number.isSafeInteger(outcome.dispatchDeadlineSeconds)
    || outcome.dispatchDeadlineSeconds < 30 || outcome.dispatchDeadlineSeconds > 86_400
    || !Number.isSafeInteger(outcome.fulfillmentSeconds)
    || outcome.fulfillmentSeconds < 30 || outcome.fulfillmentSeconds > 31_536_000
    || !["stock-fixed-v1", "recipe-bound-v1", "recipe-bound-v2"].includes(
      outcome.bindingProfile,
    )
    || !outcome.requestSchema || outcome.requestSchema.type !== "object"
    || outcome.requestSchema.additionalProperties !== false
    || !outcome.requestSchema.properties
    || !outcome.resultSchema || outcome.resultSchema.type !== "object"
    || outcome.resultSchema.additionalProperties !== false
    || !outcome.resultSchema.properties
  ) throw new Error(`Outcome ${outcome.outcomeId} policy is invalid`);
  if (
    outcome.bindingProfile === "stock-fixed-v1"
    && (Object.keys(outcome.requestSchema.properties).length !== 0
      || (outcome.requestSchema.required?.length ?? 0) !== 0)
  ) throw new Error(`Outcome ${outcome.outcomeId} stock-fixed requests must be empty`);
}

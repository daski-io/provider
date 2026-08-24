import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  getCreate2Address,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ProviderOutcomeConfig } from "./types.js";
import { decodeGzipBase64Json } from "./compressedJson.js";
import { assertExactKeys, assertNoDuplicateJsonKeys } from "./canonical.js";
import type { ProviderOutcomeLaunchPolicy } from "./launchPolicy.js";

export interface ProviderStandardRailConfig {
  environment: string;
  chainId: number;
  gatewayAudience: string;
  gatewayOrigin: string;
  providerAudience: string;
  gatewayDispatchSigner: Address;
  gatewayQuoteSigner: Address;
  gatewayLifecycleSigner: Address;
  providerAuthorityKey: Address;
  providerAuthorityPrivateKey: Hex;
  terminalAttestationPrivateKey: Hex;
  terminalAttestationKey: Address;
  evidenceRpcUrls: readonly [string, ...string[]];
  outcomes: ReadonlyMap<string, ProviderOutcomeConfig>;
  finalityConfirmations: number;
  sanctionsOracleAddress: Address;
  reputationContract: Address;
  easAddress: Address;
  easRuntimeCodeHash: Hex;
  reputationOutcomeSchemaUid: Hex;
  reputationRetryDelaysSeconds: readonly [number, number, number, number];
}

const need = (env: NodeJS.ProcessEnv, name: string): string => {
  const found = env[name]?.trim();
  if (!found) throw new Error(`${name} is required for the standard rail`);
  return found;
};

function key(env: NodeJS.ProcessEnv, name: string): Hex {
  const found = need(env, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(found) || /^0x0+$/.test(found)) {
    throw new Error(`${name} must be a non-zero 32-byte private key`);
  }
  return found as Hex;
}

export function loadProviderStandardRailConfig(
  launchPolicy: ProviderOutcomeLaunchPolicy,
  env: NodeJS.ProcessEnv = process.env,
): ProviderStandardRailConfig {
  const chainId = Number(need(env, "CHAIN_ID"));
  if (chainId !== 8453 && chainId !== 84532) throw new Error("CHAIN_ID must identify Base");
  const urls = [need(env, "BASE_RPC_URL"), ...(env.BASE_RPC_FALLBACK_URLS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean)].map((raw) => {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("Provider RPC URLs must be credential-free HTTPS URLs");
    }
    return parsed.toString();
  });
  let parsedOutcomes: ProviderOutcomeConfig[];
  try {
    const outcomesText = decodeGzipBase64Json(
      need(env, "STANDARD_RAIL_OUTCOMES_JSON"),
    );
    assertNoDuplicateJsonKeys(outcomesText);
    parsedOutcomes = JSON.parse(outcomesText);
    if (!Array.isArray(parsedOutcomes)) throw new Error();
  } catch {
    throw new Error("Standard-rail provider JSON configuration is malformed");
  }
  const outcomes = new Map(parsedOutcomes.map((outcome) => [outcome.outcomeId, outcome]));
  const reviewedOutcomeIds = new Set(launchPolicy.outcomeIds);
  if (
    reviewedOutcomeIds.size !== launchPolicy.outcomeIds.length ||
    [...reviewedOutcomeIds].some((outcomeId) => outcomeId.trim().length === 0)
  ) {
    throw new Error("Provider launch outcome policy is invalid");
  }
  if (outcomes.size !== parsedOutcomes.length ||
      outcomes.size !== reviewedOutcomeIds.size ||
      [...reviewedOutcomeIds].some((outcomeId) => !outcomes.has(outcomeId))) {
    throw new Error("STANDARD_RAIL_OUTCOMES_JSON differs from the reviewed launch outcome set");
  }
  const providerAuthorityPrivateKey = key(env, "PROVIDER_WALLET_PRIVATE_KEY");
  const providerAuthorityKey = privateKeyToAccount(providerAuthorityPrivateKey).address;
  const terminalAttestationPrivateKey = providerAuthorityPrivateKey;
  const terminalAttestationKey = privateKeyToAccount(terminalAttestationPrivateKey).address;
  const canonicalToken = getAddress(need(env, "USDC_ADDRESS"));
  for (const outcome of parsedOutcomes) {
    validateOutcome(outcome, chainId);
    if (!Number.isSafeInteger(outcome.maxOpenOrders) || outcome.maxOpenOrders <= 0) {
      throw new Error(`Outcome ${outcome.outcomeId} requires a positive maxOpenOrders`);
    }
    if (getAddress(outcome.providerTerminalAttestationKey) !== terminalAttestationKey) {
      throw new Error(`Outcome ${outcome.outcomeId} terminal attestation key mismatch`);
    }
    if (getAddress(outcome.token) !== canonicalToken) {
      throw new Error(`Outcome ${outcome.outcomeId} token does not match the reviewed canonical token`);
    }
  }
  if (new Set(parsedOutcomes.map((outcome) => outcome.sanctionsOracleRuntimeCodeHash.toLowerCase())).size !== 1) {
    throw new Error("All standard outcomes must pin the same sanctions-oracle runtime code hash");
  }
  if (new Set(parsedOutcomes.map((outcome) => JSON.stringify({
    tokenRuntimeCodeHash: outcome.tokenRuntimeCodeHash.toLowerCase(),
    tokenImplementationAddress: getAddress(outcome.tokenImplementationAddress).toLowerCase(),
    tokenImplementationRuntimeCodeHash: outcome.tokenImplementationRuntimeCodeHash.toLowerCase(),
    tokenImplementationSlot: outcome.tokenImplementationSlot.toLowerCase(),
    tokenDomainSeparator: outcome.tokenDomainSeparator.toLowerCase(),
  }))).size !== 1) {
    throw new Error("All standard outcomes must pin one canonical-token implementation policy");
  }
  const finalityConfirmations = Number(env.STANDARD_RAIL_FINALITY_CONFIRMATIONS ?? 12);
  if (!Number.isSafeInteger(finalityConfirmations) || finalityConfirmations <= 0) {
    throw new Error("STANDARD_RAIL_FINALITY_CONFIRMATIONS must be a positive integer");
  }
  const reputationRetryDelaysSeconds = [5, 60, 3_000, 30_000] as const;
  const reputationOutcomeSchemaUid = need(env, "EAS_OUTCOME_SCHEMA_UID").toLowerCase() as Hex;
  if (!/^0x[0-9a-f]{64}$/.test(reputationOutcomeSchemaUid)) {
    throw new Error("EAS_OUTCOME_SCHEMA_UID must be bytes32");
  }
  const easRuntimeCodeHash = need(env, "EAS_RUNTIME_CODE_HASH").toLowerCase() as Hex;
  if (!/^0x[0-9a-f]{64}$/.test(easRuntimeCodeHash) || /^0x0+$/.test(easRuntimeCodeHash)) {
    throw new Error("EAS_RUNTIME_CODE_HASH must be a non-zero bytes32 code hash");
  }
  const gatewayDispatchSigner = getAddress(need(env, "STANDARD_RAIL_GATEWAY_SIGNER"));
  const gatewayQuoteSigner = gatewayDispatchSigner;
  const gatewayLifecycleSigner = gatewayDispatchSigner;
  const gatewayOriginRaw = env.STANDARD_RAIL_GATEWAY_ORIGIN?.trim() || need(env, "GATEWAY_BASE_URL");
  const providerAudience = env.STANDARD_RAIL_PROVIDER_AUDIENCE?.trim() || need(env, "BASE_URL");
  return {
    environment: env.STANDARD_RAIL_ENVIRONMENT?.trim() || (chainId === 8453 ? "mainnet" : "testnet"),
    chainId,
    gatewayAudience: env.STANDARD_RAIL_GATEWAY_AUDIENCE?.trim() || gatewayOriginRaw,
    gatewayOrigin: (() => {
      const parsed = new URL(gatewayOriginRaw);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        throw new Error("STANDARD_RAIL_GATEWAY_ORIGIN must be a credential-free HTTPS origin");
      }
      return parsed.origin;
    })(),
    providerAudience,
    gatewayDispatchSigner,
    gatewayQuoteSigner,
    gatewayLifecycleSigner,
    providerAuthorityKey,
    providerAuthorityPrivateKey,
    terminalAttestationPrivateKey,
    terminalAttestationKey,
    evidenceRpcUrls: urls as [string, ...string[]],
    outcomes,
    finalityConfirmations,
    sanctionsOracleAddress: getAddress(need(env, "SANCTIONS_ORACLE_ADDRESS")),
    reputationContract: getAddress(need(env, "REPUTATION_STORAGE_ADDRESS")),
    easAddress: getAddress(need(env, "EAS_ADDRESS")),
    easRuntimeCodeHash,
    reputationOutcomeSchemaUid,
    reputationRetryDelaysSeconds,
  };
}

function validateOutcome(outcome: ProviderOutcomeConfig, chainId: number): void {
  assertExactKeys(outcome, [
    "outcomeId", "serviceSlug", "serviceId", "skillId", "listingManifestHash", "providerOfferHash",
    "pricingMode", "fixedGrossAmount", "quoteMaximumLifetimeSeconds",
    "quoteMinimumPaymentWindowSeconds",
    "providerControlProfileHash", "activeRailProfileHash", "customerIdentityPolicyId", "token", "splitter", "splitterRuntimeCodeHash",
    "splitterFactory", "splitterFactoryRuntimeCodeHash", "splitterCreationCode", "splitterCreationCodeHash",
    "splitterInitCodeHash", "splitterDeploymentSalt", "splitterDeploymentTransaction",
    "splitterDeploymentBlockNumber", "splitterDeploymentBlockHash",
    "splitterActivationBlockNumber", "splitterActivationBlockHash", "splitterActivationPosition",
    "splitterStartingTokenBalance", "splitterStartingReleaseSequence", "tokenRuntimeCodeHash",
    "tokenImplementationAddress", "tokenImplementationRuntimeCodeHash", "tokenImplementationSlot",
    "tokenDomainSeparator",
    "sanctionsOracleRuntimeCodeHash", "providerControlledWallets",
    "maximumSourceLagBlocks", "maximumLogPageEvents", "listingCommitmentHash", "outcomeIdHash", "policyVersionHash",
    "listingEpoch", "providerPayee", "providerTerminalAttestationKey", "daskiCommissionReceiver",
    "commissionBps", "maxOpenOrders", "dispatchDeadlineSeconds",
    "bindingProfile", "requestSchema",
  ], `outcome ${outcome.outcomeId}`);
  const hex32 = /^0x[0-9a-fA-F]{64}$/;
  for (const field of [
    "outcomeId", "serviceSlug", "skillId", "listingEpoch",
  ] as const) {
    if (typeof outcome[field] !== "string" || outcome[field].length === 0) {
      throw new Error(`Standard outcome ${field} must be a non-empty string`);
    }
  }
  if (!/^\d+$/.test(outcome.listingEpoch)) {
    throw new Error(`Outcome ${outcome.outcomeId} listingEpoch must be an unsigned integer`);
  }
  if (
    (outcome.pricingMode !== "fixed" && outcome.pricingMode !== "dynamic") ||
    (outcome.pricingMode === "fixed" && !/^[1-9]\d*$/.test(outcome.fixedGrossAmount)) ||
    (outcome.pricingMode === "dynamic" && outcome.fixedGrossAmount !== "0") ||
    (outcome.pricingMode === "fixed" &&
      (outcome.quoteMaximumLifetimeSeconds !== 0 || outcome.quoteMinimumPaymentWindowSeconds !== 0)) ||
    (outcome.pricingMode === "dynamic" &&
      (!Number.isSafeInteger(outcome.quoteMaximumLifetimeSeconds) ||
        outcome.quoteMaximumLifetimeSeconds < 30 ||
        outcome.quoteMaximumLifetimeSeconds > 300 ||
        !Number.isSafeInteger(outcome.quoteMinimumPaymentWindowSeconds) ||
        outcome.quoteMinimumPaymentWindowSeconds < 15 ||
        outcome.quoteMinimumPaymentWindowSeconds >= outcome.quoteMaximumLifetimeSeconds)) ||
    (outcome.bindingProfile === "stock-fixed-v1" && outcome.pricingMode !== "fixed")
  ) throw new Error(`Outcome ${outcome.outcomeId} pricing policy is invalid`);
  const unsignedInteger = /^(0|[1-9]\d*)$/;
  if (
    !unsignedInteger.test(outcome.splitterDeploymentBlockNumber) ||
    !unsignedInteger.test(outcome.splitterActivationBlockNumber) ||
    !unsignedInteger.test(outcome.splitterStartingTokenBalance) ||
    !unsignedInteger.test(outcome.splitterStartingReleaseSequence) ||
    BigInt(outcome.splitterActivationBlockNumber) < BigInt(outcome.splitterDeploymentBlockNumber) ||
    BigInt(outcome.splitterStartingTokenBalance) >= 1n << 256n ||
    BigInt(outcome.splitterStartingReleaseSequence) >= 1n << 64n ||
    BigInt(outcome.listingEpoch) === 0n ||
    BigInt(outcome.listingEpoch) >= 1n << 64n ||
    outcome.splitterActivationPosition !== "END_OF_BLOCK"
  ) {
    throw new Error(`Outcome ${outcome.outcomeId} splitter activation checkpoint is invalid`);
  }
  for (const field of [
    "serviceId", "listingManifestHash", "providerOfferHash", "providerControlProfileHash", "activeRailProfileHash",
    "splitterFactoryRuntimeCodeHash", "splitterCreationCodeHash", "splitterInitCodeHash",
    "splitterDeploymentSalt", "splitterRuntimeCodeHash", "splitterDeploymentTransaction",
    "splitterDeploymentBlockHash", "splitterActivationBlockHash",
    "tokenRuntimeCodeHash", "listingCommitmentHash",
    "tokenImplementationRuntimeCodeHash", "tokenImplementationSlot", "tokenDomainSeparator",
    "sanctionsOracleRuntimeCodeHash", "outcomeIdHash", "policyVersionHash",
  ] as const) {
    if (!hex32.test(outcome[field])) throw new Error(`Outcome ${outcome.outcomeId} ${field} is invalid`);
  }
  for (const field of [
    "token", "tokenImplementationAddress", "splitter", "splitterFactory", "providerPayee",
    "providerTerminalAttestationKey", "daskiCommissionReceiver",
  ] as const) {
    getAddress(outcome[field]);
  }
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(outcome.splitterCreationCode)) {
    throw new Error(`Outcome ${outcome.outcomeId} splitter creation code is invalid`);
  }
  const constructorArgs = encodeAbiParameters(
    [
      { type: "uint256" }, { type: "address" }, { type: "address" },
      { type: "address" }, { type: "uint16" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" },
    ],
    [
      BigInt(chainId), getAddress(outcome.token), getAddress(outcome.providerPayee),
      getAddress(outcome.daskiCommissionReceiver), outcome.commissionBps, outcome.policyVersionHash,
      outcome.outcomeIdHash, outcome.listingCommitmentHash, BigInt(outcome.listingEpoch),
    ],
  );
  const creationCodeHash = keccak256(outcome.splitterCreationCode);
  const initCodeHash = keccak256(concatHex([outcome.splitterCreationCode, constructorArgs]));
  if (
    creationCodeHash.toLowerCase() !== outcome.splitterCreationCodeHash.toLowerCase() ||
    initCodeHash.toLowerCase() !== outcome.splitterInitCodeHash.toLowerCase() ||
    getCreate2Address({
      from: getAddress(outcome.splitterFactory),
      salt: outcome.splitterDeploymentSalt,
      bytecodeHash: initCodeHash,
    }) !== getAddress(outcome.splitter)
  ) throw new Error(`Outcome ${outcome.outcomeId} splitter provenance is invalid`);
  if (
    !Array.isArray(outcome.providerControlledWallets) ||
    outcome.providerControlledWallets.some((value) => !/^0x[0-9a-fA-F]{40}$/.test(value)) ||
    new Set(outcome.providerControlledWallets.map((value) => getAddress(value).toLowerCase())).size !==
      outcome.providerControlledWallets.length
  ) throw new Error(`Outcome ${outcome.outcomeId} provider-controlled wallet set is invalid`);
  if (
    !Number.isSafeInteger(outcome.commissionBps) || outcome.commissionBps <= 0 ||
    outcome.commissionBps >= 10_000 ||
    !Number.isSafeInteger(outcome.maximumSourceLagBlocks) || outcome.maximumSourceLagBlocks < 0 ||
    !Number.isSafeInteger(outcome.maximumLogPageEvents) || outcome.maximumLogPageEvents < 1 ||
    outcome.maximumLogPageEvents > 100_000 ||
    !Number.isSafeInteger(outcome.dispatchDeadlineSeconds) || outcome.dispatchDeadlineSeconds < 30 ||
    outcome.dispatchDeadlineSeconds > 86_400 ||
    outcome.customerIdentityPolicyId !== "none" ||
    (outcome.bindingProfile !== "stock-fixed-v1" && outcome.bindingProfile !== "recipe-bound-v1") ||
    !outcome.requestSchema || outcome.requestSchema.type !== "object" ||
    outcome.requestSchema.additionalProperties !== false ||
    !outcome.requestSchema.properties || typeof outcome.requestSchema.properties !== "object" ||
    (outcome.requestSchema.required !== undefined && !Array.isArray(outcome.requestSchema.required))
  ) throw new Error(`Outcome ${outcome.outcomeId} policy is invalid`);
  for (const required of outcome.requestSchema.required ?? []) {
    if (typeof required !== "string" || !(required in outcome.requestSchema.properties)) {
      throw new Error(`Outcome ${outcome.outcomeId} request schema has an invalid required field`);
    }
  }
  if (
    outcome.bindingProfile === "stock-fixed-v1" &&
    (Object.keys(outcome.requestSchema.properties).length !== 0 ||
      (outcome.requestSchema.required?.length ?? 0) !== 0)
  ) throw new Error(`Outcome ${outcome.outcomeId} stock-fixed policy cannot accept request fields`);
}

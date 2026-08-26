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
import { assertExactKeys, assertNoDuplicateJsonKeys } from "./canonical.js";
import { decodeGzipBase64Json } from "./compressedJson.js";
import type { ProviderOutcomeLaunchPolicy } from "./launchPolicy.js";
import type { ProviderOutcomeConfig } from "./types.js";

export interface ProviderStandardRailConfig {
  environment: string;
  chainId: number;
  gatewayAudience: string;
  providerAudience: string;
  gatewayDispatchSigner: Address;
  gatewayQuoteSigner: Address;
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
}

const need = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the standard rail`);
  return value;
};

const privateKey = (env: NodeJS.ProcessEnv, name: string): Hex => {
  const value = need(env, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0+$/.test(value)) {
    throw new Error(`${name} must be a non-zero 32-byte private key`);
  }
  return value as Hex;
};

const bytes32 = (value: string, name: string, nonzero = false): Hex => {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized) || (nonzero && /^0x0+$/.test(normalized))) {
    throw new Error(`${name} must be ${nonzero ? "a non-zero " : ""}bytes32`);
  }
  return normalized as Hex;
};

export function loadProviderStandardRailConfig(
  launchPolicy: ProviderOutcomeLaunchPolicy,
  env: NodeJS.ProcessEnv = process.env,
): ProviderStandardRailConfig {
  const chainId = Number(need(env, "CHAIN_ID"));
  if (chainId !== 8453 && chainId !== 84532) throw new Error("CHAIN_ID must identify Base");
  const evidenceRpcUrls = [
    need(env, "BASE_RPC_URL"),
    ...(env.BASE_RPC_FALLBACK_URLS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  ].map((raw) => {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("Provider RPC URLs must be credential-free HTTPS URLs");
    }
    return parsed.toString();
  }) as [string, ...string[]];

  let parsedOutcomes: ProviderOutcomeConfig[];
  try {
    const json = decodeGzipBase64Json(need(env, "STANDARD_RAIL_OUTCOMES_JSON"));
    assertNoDuplicateJsonKeys(json);
    parsedOutcomes = JSON.parse(json) as ProviderOutcomeConfig[];
    if (!Array.isArray(parsedOutcomes)) throw new Error();
  } catch {
    throw new Error("Standard-rail provider JSON configuration is malformed");
  }
  const outcomes = new Map(parsedOutcomes.map((outcome) => [outcome.outcomeId, outcome]));
  const reviewed = new Set(launchPolicy.outcomeIds);
  if (
    reviewed.size !== launchPolicy.outcomeIds.length
    || outcomes.size !== parsedOutcomes.length
    || outcomes.size !== reviewed.size
    || [...reviewed].some((id) => !id.trim() || !outcomes.has(id))
  ) {
    throw new Error("STANDARD_RAIL_OUTCOMES_JSON differs from providerLaunchPolicy");
  }

  const providerAuthorityPrivateKey = privateKey(env, "PROVIDER_WALLET_PRIVATE_KEY");
  const providerAuthorityKey = privateKeyToAccount(providerAuthorityPrivateKey).address;
  const terminalAttestationPrivateKey = providerAuthorityPrivateKey;
  const terminalAttestationKey = providerAuthorityKey;
  const canonicalToken = getAddress(need(env, "USDC_ADDRESS"));
  for (const outcome of parsedOutcomes) {
    validateOutcome(outcome, chainId);
    if (getAddress(outcome.providerTerminalAttestationKey) !== terminalAttestationKey) {
      throw new Error(`Outcome ${outcome.outcomeId} terminal attestation key mismatch`);
    }
    if (getAddress(outcome.token) !== canonicalToken) {
      throw new Error(`Outcome ${outcome.outcomeId} token is not configured USDC`);
    }
  }
  if (
    new Set(parsedOutcomes.map((outcome) =>
      outcome.sanctionsOracleRuntimeCodeHash.toLowerCase())).size !== 1
  ) {
    throw new Error("All outcomes must pin one sanctions-oracle runtime code hash");
  }
  if (new Set(parsedOutcomes.map((outcome) => JSON.stringify({
    tokenRuntimeCodeHash: outcome.tokenRuntimeCodeHash.toLowerCase(),
    tokenImplementationAddress: getAddress(outcome.tokenImplementationAddress).toLowerCase(),
    tokenImplementationRuntimeCodeHash: outcome.tokenImplementationRuntimeCodeHash.toLowerCase(),
    tokenImplementationSlot: outcome.tokenImplementationSlot.toLowerCase(),
    tokenDomainSeparator: outcome.tokenDomainSeparator.toLowerCase(),
  }))).size !== 1) {
    throw new Error("All outcomes must pin one canonical-token implementation policy");
  }

  const finalityConfirmations = Number(env.STANDARD_RAIL_FINALITY_CONFIRMATIONS ?? 12);
  if (!Number.isSafeInteger(finalityConfirmations) || finalityConfirmations < 1) {
    throw new Error("STANDARD_RAIL_FINALITY_CONFIRMATIONS must be positive");
  }
  const gatewaySigner = getAddress(need(env, "STANDARD_RAIL_GATEWAY_SIGNER"));
  return {
    environment: env.STANDARD_RAIL_ENVIRONMENT?.trim() || (chainId === 8453 ? "mainnet" : "testnet"),
    chainId,
    gatewayAudience:
      env.STANDARD_RAIL_GATEWAY_AUDIENCE?.trim() || need(env, "GATEWAY_BASE_URL"),
    providerAudience:
      env.STANDARD_RAIL_PROVIDER_AUDIENCE?.trim() || need(env, "BASE_URL"),
    gatewayDispatchSigner: gatewaySigner,
    gatewayQuoteSigner: gatewaySigner,
    providerAuthorityKey,
    providerAuthorityPrivateKey,
    terminalAttestationPrivateKey,
    terminalAttestationKey,
    evidenceRpcUrls,
    outcomes,
    finalityConfirmations,
    sanctionsOracleAddress: getAddress(need(env, "SANCTIONS_ORACLE_ADDRESS")),
    reputationContract: getAddress(need(env, "REPUTATION_STORAGE_ADDRESS")),
    easAddress: getAddress(need(env, "EAS_ADDRESS")),
    easRuntimeCodeHash: bytes32(need(env, "EAS_RUNTIME_CODE_HASH"), "EAS_RUNTIME_CODE_HASH", true),
    reputationOutcomeSchemaUid: bytes32(
      need(env, "EAS_OUTCOME_SCHEMA_UID"),
      "EAS_OUTCOME_SCHEMA_UID",
    ),
  };
}

function validateOutcome(outcome: ProviderOutcomeConfig, chainId: number): void {
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
    "bindingProfile", "requestSchema",
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
    || !["stock-fixed-v1", "recipe-bound-v1"].includes(outcome.bindingProfile)
    || !outcome.requestSchema || outcome.requestSchema.type !== "object"
    || outcome.requestSchema.additionalProperties !== false
    || !outcome.requestSchema.properties
  ) throw new Error(`Outcome ${outcome.outcomeId} policy is invalid`);
  if (
    outcome.bindingProfile === "stock-fixed-v1"
    && (Object.keys(outcome.requestSchema.properties).length !== 0
      || (outcome.requestSchema.required?.length ?? 0) !== 0)
  ) throw new Error(`Outcome ${outcome.outcomeId} stock-fixed requests must be empty`);
}

import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  loadRuntimeListingVersions,
  type RuntimeListingHead,
  type RuntimeListingVersion,
} from "../gatewayRegistration/runtimeCatalog.js";
import {
  loadStandardRailGlobalPolicy,
  type StandardRailGlobalPolicy,
} from "./catalogOutcomes.js";
import type { ProviderOutcomeLaunchPolicy } from "./launchPolicy.js";
import { validateOutcome } from "./outcomeValidation.js";
import { parseRetainedSigningKeys, parseServicingAudiences } from "./retainedConfig.js";
import { buildServicingCatalog, type UnserviceableReason } from "./servicingCatalog.js";
import type { ProviderOutcomeConfig } from "./types.js";

export interface ProviderStandardRailConfig {
  environment: string;
  chainId: number;
  gatewayAudience: string;
  gatewayOrigin: string;
  providerAudience: string;
  gatewayDispatchSigner: Address;
  gatewayQuoteSigner: Address;
  /** Signs ProviderLifecycleGrantV1 as `gateway-lifecycle`. */
  gatewayLifecycleSigner: Address;
  providerAuthorityKey: Address;
  providerAuthorityPrivateKey: Hex;
  terminalAttestationPrivateKey: Hex;
  terminalAttestationKey: Address;
  evidenceRpcUrls: readonly [string, ...string[]];
  /** New-sale heads by outcome id: quotes, intake and the outcome list. */
  outcomes: ReadonlyMap<string, ProviderOutcomeConfig>;
  /**
   * Every installed version this build services, heads included, by listing
   * manifest (runtime commitment) hash, with its admitted definition.
   */
  servicing: ReadonlyMap<Hex, ProviderOutcomeConfig>;
  /** Installed versions this build cannot service, with the reason. */
  unserviceable: ReadonlyMap<Hex, UnserviceableReason>;
  /** Each installed version's provider wallet: the key its orders' answers carry. */
  listingWallets: ReadonlyMap<Hex, Address>;
  /** Previous provider wallet keys by address; secrets. */
  retainedSigningKeys: ReadonlyMap<Address, Hex>;
  /** Provider audiences servicing calls may name: current plus retained. */
  servicingAudiences: ReadonlySet<string>;
  globalPolicy: StandardRailGlobalPolicy;
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

/**
 * The gateway origin that scopes the runtime catalog and the gateway
 * audience every claim is keyed by: STANDARD_RAIL_GATEWAY_ORIGIN (else
 * GATEWAY_BASE_URL) and STANDARD_RAIL_GATEWAY_AUDIENCE (else that origin).
 */
export function resolveGatewayIdentity(env: NodeJS.ProcessEnv): {
  gatewayOrigin: string;
  gatewayAudience: string;
} {
  const parsed = new URL(
    env.STANDARD_RAIL_GATEWAY_ORIGIN?.trim() || need(env, "GATEWAY_BASE_URL"),
  );
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password ||
    parsed.pathname !== "/" || parsed.search || parsed.hash
  ) throw new Error("STANDARD_RAIL_GATEWAY_ORIGIN must be a credential-free HTTPS origin");
  return {
    gatewayOrigin: parsed.origin,
    gatewayAudience: env.STANDARD_RAIL_GATEWAY_AUDIENCE?.trim() || parsed.origin,
  };
}

export async function loadProviderStandardRailConfig(
  launchPolicy: ProviderOutcomeLaunchPolicy,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    warn?: (message: string) => void;
    headsOverride?: readonly RuntimeListingHead[];
    versionsOverride?: readonly RuntimeListingVersion[];
  } = {},
): Promise<ProviderStandardRailConfig> {
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

  const providerAuthorityPrivateKey = privateKey(env, "PROVIDER_WALLET_PRIVATE_KEY");
  const providerAuthorityKey = privateKeyToAccount(providerAuthorityPrivateKey).address;
  const terminalAttestationPrivateKey = providerAuthorityPrivateKey;
  const terminalAttestationKey = providerAuthorityKey;
  const canonicalToken = getAddress(need(env, "USDC_ADDRESS"));
  const environment =
    env.STANDARD_RAIL_ENVIRONMENT?.trim() || (chainId === 8453 ? "mainnet" : "testnet");
  const gatewaySigner = getAddress(need(env, "STANDARD_RAIL_GATEWAY_SIGNER"));
  const { gatewayOrigin, gatewayAudience } = resolveGatewayIdentity(env);
  const reviewedPaidSkills = new Set(launchPolicy.paidSkills.map((skill) =>
    `${skill.serviceSlug}:${skill.skillId}`));
  if (reviewedPaidSkills.size !== launchPolicy.paidSkills.length) {
    throw new Error("Provider paid-skill launch policy is invalid");
  }
  const globalPolicy = await loadStandardRailGlobalPolicy({
    environment,
    chainId,
    gatewayAudience,
    gatewaySigner,
    env,
  });
  const providerControlProfileHash = bytes32(
    need(env, "STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH"),
    "STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH",
  );
  const catalog = buildServicingCatalog({
    versions: options.versionsOverride
      ?? options.headsOverride?.map((head) => ({ ...head, supersededAt: null }))
      ?? await loadRuntimeListingVersions(gatewayOrigin),
    globalPolicy,
    chainId,
    providerControlProfileHash,
    installedPaidSkills: reviewedPaidSkills,
    canonicalToken,
    strictHeads: true,
    warn: options.warn,
  });
  const outcomes = catalog.heads;
  const parsedOutcomes = [...outcomes.values()];
  for (const outcome of parsedOutcomes) {
    validateOutcome(outcome, chainId);
    // New sales are signed with the current key only.
    if (getAddress(outcome.providerTerminalAttestationKey) !== terminalAttestationKey) {
      throw new Error(`Outcome ${outcome.outcomeId} terminal attestation key mismatch`);
    }
    if (getAddress(outcome.token) !== canonicalToken) {
      throw new Error(`Outcome ${outcome.outcomeId} token is not configured USDC`);
    }
  }
  // A superseded version this build cannot vouch for is left out of
  // servicing; boot refuses only if it still has obligations
  // (retainedObligations.ts).
  if (
    parsedOutcomes.length > 0 &&
    new Set(parsedOutcomes.map((outcome) =>
      outcome.sanctionsOracleRuntimeCodeHash.toLowerCase())).size !== 1
  ) {
    throw new Error("All outcomes must pin one sanctions-oracle runtime code hash");
  }
  if (parsedOutcomes.length > 0 && new Set(parsedOutcomes.map((outcome) => JSON.stringify({
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
  const providerAudience = env.STANDARD_RAIL_PROVIDER_AUDIENCE?.trim() || need(env, "BASE_URL");
  return {
    environment,
    chainId,
    gatewayAudience,
    gatewayOrigin,
    providerAudience,
    // The gateway signs every protocol artifact with its one protocol key;
    // each key id still names its own role and is checked separately.
    gatewayDispatchSigner: gatewaySigner,
    gatewayQuoteSigner: gatewaySigner,
    gatewayLifecycleSigner: gatewaySigner,
    providerAuthorityKey,
    providerAuthorityPrivateKey,
    terminalAttestationPrivateKey,
    terminalAttestationKey,
    evidenceRpcUrls,
    outcomes,
    servicing: catalog.servicing,
    unserviceable: catalog.unserviceable,
    listingWallets: catalog.listingWallets,
    retainedSigningKeys: parseRetainedSigningKeys(env, providerAuthorityPrivateKey),
    servicingAudiences: parseServicingAudiences(env, providerAudience),
    globalPolicy,
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

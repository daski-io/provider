import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ServiceModule, ServiceResult } from "../src/core/serviceRegistry/types.js";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import type { ProviderOutcomeConfig } from "../src/core/standardRail/types.js";
import { gatewaySigner, providerKey, type GatewayListing } from "./gatewayWire.js";
import { standardOutcome } from "./standardRailOutcomeFixture.js";

/** The runtime catalog names an outcome by its skill id. */
export function railOutcome(overrides: Partial<ProviderOutcomeConfig> = {}): ProviderOutcomeConfig {
  return { ...standardOutcome(), outcomeId: "echo", bindingProfile: "recipe-bound-v2", ...overrides };
}

export function railConfig(
  outcomes: ProviderOutcomeConfig[] = [railOutcome()],
  retained: {
    /** Superseded versions still serviced for orders paid against them. */
    versions?: ProviderOutcomeConfig[];
    keys?: Hex[];
    audiences?: string[];
    /** Earlier control profiles a first dispatch may still carry. */
    controlProfiles?: Hex[];
  } = {},
): ProviderStandardRailConfig {
  const authority = privateKeyToAccount(providerKey).address;
  const servicing = [...outcomes, ...(retained.versions ?? [])];
  return {
    environment: "testnet",
    chainId: 84532,
    gatewayAudience: "https://gateway.example",
    gatewayOrigin: "https://gateway.example",
    providerAudience: "https://provider.example",
    gatewayDispatchSigner: gatewaySigner,
    gatewayQuoteSigner: gatewaySigner,
    gatewayLifecycleSigner: gatewaySigner,
    providerAuthorityKey: authority,
    providerAuthorityPrivateKey: providerKey,
    terminalAttestationPrivateKey: providerKey,
    terminalAttestationKey: authority,
    evidenceRpcUrls: ["https://rpc.example"],
    outcomes: new Map(outcomes.map((outcome) => [outcome.outcomeId, outcome])),
    servicing: new Map(servicing.map((outcome) => [outcome.listingManifestHash, outcome])),
    unserviceable: new Map(),
    listingWallets: new Map(servicing.map((outcome) => [
      outcome.listingManifestHash, getAddress(outcome.providerTerminalAttestationKey),
    ])),
    retainedSigningKeys: new Map((retained.keys ?? []).map((key) => [privateKeyToAccount(key).address, key])),
    servicingAudiences: new Set(["https://provider.example", ...(retained.audiences ?? [])]),
    providerControlProfileHash: (outcomes[0] ?? railOutcome()).providerControlProfileHash,
    retainedControlProfileHashes: retained.controlProfiles ?? [],
    globalPolicy: {} as never,
    finalityConfirmations: 12,
    sanctionsOracleAddress: "0x5555555555555555555555555555555555555555",
    reputationContract: "0x4545454545454545454545454545454545454545",
    easAddress: "0x4646464646464646464646464646464646464646",
    easRuntimeCodeHash: `0x${"f".repeat(64)}` as Hex,
    reputationOutcomeSchemaUid: `0x${"e".repeat(64)}` as Hex,
  };
}

/** How the gateway's listing sees the same outcome. */
export function gatewayListing(outcome: ProviderOutcomeConfig = railOutcome()): GatewayListing {
  return {
    outcomeId: outcome.outcomeId,
    listingManifestHash: outcome.listingManifestHash,
    fixedGrossAmount: outcome.fixedGrossAmount,
    commissionBps: outcome.commissionBps,
    providerAuthorityKey: privateKeyToAccount(providerKey).address,
    minimumPaymentWindowSeconds: 30,
    requestSchema: outcome.requestSchema,
  };
}

export function echoService(overrides: Partial<ServiceModule> & {
  execute?: (input: Record<string, unknown>) => Promise<ServiceResult>;
} = {}): ServiceModule {
  const { execute, ...module } = overrides;
  return {
    manifest: {
      slug: "dummy",
      version: "1",
      name: "Echo",
      description: "Echo test service",
      categoryFamily: "other",
      serviceType: "other",
      jurisdictions: ["global"],
      turnaroundEstimate: "< 5 seconds",
    },
    skills: [{
      id: "echo",
      name: "Echo",
      description: "Echo",
      examples: [],
      fixedPriceAtomic: "10000",
      inputSchema: {},
      resultSchema: {},
    }],
    adapter: {
      execute: async (_context, input) => execute
        ? execute(input)
        : { status: "completed", message: "Echo completed." },
    },
    readiness: async () => true,
    docs: { service: "Echo", skills: { echo: "Echo" } },
    ...module,
  };
}

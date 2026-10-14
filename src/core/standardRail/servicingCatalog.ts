import { getAddress, type Address, type Hex } from "viem";
import type { RuntimeListingVersion } from "../gatewayRegistration/runtimeCatalog.js";
import {
  materializeCatalogOutcomes,
  materializeOutcome,
  type StandardRailGlobalPolicy,
} from "./catalogOutcomes.js";
import { validateOutcome } from "./outcomeValidation.js";
import { walletAddress } from "./retainedConfig.js";
import { compileProviderSchema } from "./schema.js";
import type { ProviderOutcomeConfig } from "./types.js";

/** Why an installed version cannot be serviced by this build. */
export type UnserviceableReason =
  | "definition_invalid"
  | "skill_not_installed"
  | "schema_invalid";

/**
 * What this build can do for each installed listing version. `heads` take
 * new sales. `servicing` holds every version, heads included, keyed by its
 * runtime commitment hash (re-verified against its content), with the
 * definition it was admitted with: request and result schemas, price,
 * deadlines, fulfillment window and handler. A funded order paid against a
 * superseded version is served with that version's definition.
 */
export interface ServicingCatalog {
  heads: Map<string, ProviderOutcomeConfig>;
  servicing: Map<Hex, ProviderOutcomeConfig>;
  /** Every installed version's provider wallet: the key its orders' snapshots name. */
  listingWallets: Map<Hex, Address>;
  unserviceable: Map<Hex, UnserviceableReason>;
}

export function buildServicingCatalog(args: {
  versions: readonly RuntimeListingVersion[];
  globalPolicy: StandardRailGlobalPolicy;
  chainId: number;
  providerControlProfileHash: Hex;
  installedPaidSkills: ReadonlySet<string>;
  /** The configured canonical USDC every version must settle in. */
  canonicalToken: Address;
  /** Boot refuses a head it cannot materialize; the importer judges every version by its obligations. */
  strictHeads: boolean;
  warn?: (message: string) => void;
}): ServicingCatalog {
  const paid = args.versions.filter((version) => version.paymentRequired);
  const heads = args.strictHeads
    ? materializeCatalogOutcomes({
      heads: paid.filter((version) => version.supersededAt === null),
      globalPolicy: args.globalPolicy,
      chainId: args.chainId,
      providerControlProfileHash: args.providerControlProfileHash,
      installedPaidSkills: args.installedPaidSkills,
      warn: args.warn,
    })
    : new Map<string, ProviderOutcomeConfig>();
  const catalog: ServicingCatalog = {
    heads,
    servicing: new Map([...heads.values()].map((head) => [head.listingManifestHash, head])),
    listingWallets: new Map(),
    unserviceable: new Map(),
  };
  for (const version of paid) {
    const hash = version.runtimeCommitmentHash;
    const wallet = walletAddress(version.bundle?.providerIdentity?.agentWallet);
    if (wallet) catalog.listingWallets.set(hash, wallet);
    if (catalog.servicing.has(hash)) continue;
    let outcome: ProviderOutcomeConfig;
    try {
      outcome = materializeOutcome({
        head: version,
        globalPolicy: args.globalPolicy,
        chainId: args.chainId,
        providerControlProfileHash: args.providerControlProfileHash,
      });
      validateOutcome(outcome, args.chainId);
      if (getAddress(outcome.token) !== getAddress(args.canonicalToken)) throw new Error("token");
    } catch {
      catalog.unserviceable.set(hash, "definition_invalid");
      continue;
    }
    if (!args.installedPaidSkills.has(`${outcome.serviceSlug}:${outcome.skillId}`)) {
      catalog.unserviceable.set(hash, "skill_not_installed");
      continue;
    }
    try {
      compileProviderSchema(outcome.requestSchema as unknown as Record<string, unknown>);
      compileProviderSchema(outcome.resultSchema);
    } catch {
      catalog.unserviceable.set(hash, "schema_invalid");
      continue;
    }
    catalog.servicing.set(hash, outcome);
  }
  return catalog;
}


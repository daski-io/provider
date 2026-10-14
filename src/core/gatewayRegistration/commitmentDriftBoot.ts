import type { Hex } from "viem";
import { buildContractExtension } from "../agentCards/contractExtension.js";
import { logError, logInfo } from "../logger.js";
import type { ServiceModule } from "../serviceRegistry/types.js";
import { stopNewSales } from "../standardRail/salesStops.js";
import { findListingCommitmentDrift, type ListingCommitmentDrift } from "./commitmentDrift.js";
import { loadRuntimeListingHeads } from "./runtimeCatalog.js";

/**
 * A head whose admitted skill contract differs from the one this build
 * serves stops taking new quotes (`contract_drift`) with a stable diagnostic;
 * its funded orders and every read are still serviced with the admitted
 * definition. The process stays online so Daski can read the new AgentCard
 * and issue the replacement bundle that clears it. Unreadable heads fail
 * boot: sales cannot be judged without them.
 */
export async function stopSalesOnCommitmentDrift(args: {
  gatewayOrigin: string;
  baseUrl: string;
  services: readonly ServiceModule[];
}): Promise<ListingCommitmentDrift[]> {
  const heads = await loadRuntimeListingHeads(args.gatewayOrigin);
  const bySlug = new Map(args.services.map((service) => [service.manifest.slug, service]));
  const served = new Map<string, string>();
  for (const head of heads) {
    const slug = head.bundle.intent.payload.serviceSlug;
    const service = bySlug.get(slug);
    if (!service) continue;
    const contract = buildContractExtension(service, args.baseUrl, head.serviceId)
      .skills.find((skill) => skill.skillId === head.skillId);
    if (contract) {
      served.set(`${head.serviceId.toLowerCase()}:${head.skillId}`, contract.skillContractHash);
    }
  }
  const drifts = findListingCommitmentDrift(heads, served);
  for (const drift of drifts) {
    stopNewSales(drift.listingManifestHash as Hex, "contract_drift");
    logError(
      "listing commitment drift: new quotes stopped for a skill contract its installed bundle did not commit; request and install a replacement bundle",
      { diagnostic: "listing_contract_drift", ...drift },
    );
  }
  if (drifts.length === 0) {
    logInfo("listing commitments match the served skill contracts", {
      gatewayOrigin: args.gatewayOrigin,
      heads: heads.length,
    });
  }
  return drifts;
}

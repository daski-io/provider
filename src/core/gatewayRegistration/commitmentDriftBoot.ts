import { buildContractExtension } from "../agentCards/contractExtension.js";
import { errorExtra, logError, logInfo } from "../logger.js";
import type { ServiceModule } from "../serviceRegistry/types.js";
import { findListingCommitmentDrift, type ListingCommitmentDrift } from "./commitmentDrift.js";
import { loadRuntimeListingHeads } from "./runtimeCatalog.js";

// Drift is loud but non-fatal: the new AgentCard must remain available so
// Daski can review and issue the replacement bundle that clears it.
export async function logListingCommitmentDrift(args: {
  gatewayOrigin: string;
  baseUrl: string;
  services: readonly ServiceModule[];
}): Promise<ListingCommitmentDrift[]> {
  try {
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
      logError(
        "listing commitment drift: this build serves a skill contract its installed bundle did not commit; request and install a replacement bundle",
        { ...drift },
      );
    }
    if (drifts.length === 0) {
      logInfo("listing commitments match the served skill contracts", {
        gatewayOrigin: args.gatewayOrigin,
        heads: heads.length,
      });
    }
    return drifts;
  } catch (error) {
    logError("listing commitment drift check failed", errorExtra(error));
    return [];
  }
}

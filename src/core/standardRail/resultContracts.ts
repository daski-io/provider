import type { ValidateFunction } from "ajv";
import type { Hex } from "viem";
import { getService } from "../serviceRegistry/registry.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { compileProviderSchema } from "./schema.js";
import type { ResultContract } from "./serviceResult.js";

/**
 * The admitted result contract of every installed listing version, compiled
 * once: what a terminal result of an order of that version is held to,
 * whatever the build now serves. Dispatch and the external-job worker share
 * it, so a job finishing long after its version was superseded is validated
 * against the schema it was sold under.
 */
export class ResultContracts {
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(config: Pick<ProviderStandardRailConfig, "servicing">) {
    for (const outcome of config.servicing.values()) {
      this.validators.set(outcome.listingManifestHash.toLowerCase(), compileProviderSchema(outcome.resultSchema));
    }
  }

  /** The contract for one version's orders, with the service's reviewed failure codes; null when unknown. */
  forListing(listingManifestHash: Hex, serviceSlug: string): ResultContract | null {
    const validate = this.validators.get(listingManifestHash.toLowerCase());
    const service = getService(serviceSlug);
    if (!validate || !service) return null;
    return { validate, failureCodes: new Set(service.failureCodes ?? []) };
  }
}

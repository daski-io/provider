import type { FieldEncryptionKeyRing } from "../security/fieldEncryption.js";
import { externalJobAdapterVersions } from "../serviceRegistry/adapterValidation.js";
import type { ServiceModule } from "../serviceRegistry/types.js";
import type { ExternalJobServicing } from "../standardRail/retainedObligations.js";

/**
 * What this build can do for unfinished external jobs: the adapter versions
 * its services resume (current and retained previous ones) and the key ids
 * of its key ring. Boot, the importer and activation hold every unfinished
 * job to it, so an incompatible build cannot take one over.
 */
export function externalJobServicing(
  services: readonly ServiceModule[],
  keys: FieldEncryptionKeyRing,
): ExternalJobServicing {
  const versions = new Map(services.map((service) => [
    service.manifest.slug, new Set(externalJobAdapterVersions(service)),
  ]));
  return {
    adapterVersions: (serviceSlug) => versions.get(serviceSlug) ?? new Set(),
    keyIds: new Set(keys.keys.keys()),
    canSeal: keys.activeKeyId !== null,
  };
}

/**
 * The external-job adapter versions each service can resume, as a running
 * instance declares them; activation requires every running instance to
 * declare every version new sales or unfinished jobs need, so overlapping
 * compatible processes can each take any due job.
 */
export function declaredExternalJobAdapters(services: readonly ServiceModule[]): Record<string, string[]> {
  return Object.fromEntries(services
    .map((service) => [service.manifest.slug, externalJobAdapterVersions(service).sort()] as const)
    .filter(([, versions]) => versions.length > 0));
}

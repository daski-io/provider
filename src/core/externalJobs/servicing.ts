import type { Queryable } from "../db/queryable.js";
import { liveRuntimeInstances } from "../runtimeInstance.js";
import type { FieldEncryptionKeyRing } from "../security/fieldEncryption.js";
import { externalJobAdapterVersions } from "../serviceRegistry/adapterValidation.js";
import type { ServiceModule } from "../serviceRegistry/types.js";
import { readAsyncAdmission } from "../standardRail/asyncAdmission.js";
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

/** The adapter version each external-job service sells new jobs with, as a running instance declares it. */
export function sellingExternalJobAdapters(services: readonly ServiceModule[]): Record<string, string> {
  return Object.fromEntries(services.flatMap((service) => service.adapter.mode === "external-job"
    ? [[service.manifest.slug, service.adapter.version] as const]
    : []));
}

/**
 * Boot: while async admission is on, a build may join running instances
 * only if it resumes every external-job adapter version they sell. Jobs
 * they admit during the overlap then never outlive every process that can
 * resume them; a build that cannot is refused before it serves anything
 * (retain the version in `previousExternalJobAdapters`, or stop those
 * instances first). Instances that declare no sales sell no external jobs.
 */
export async function verifyLiveExternalJobSales(db: Queryable, services: readonly ServiceModule[]): Promise<void> {
  if (!(await readAsyncAdmission(db)).enabled) return;
  const resumable = new Map(services.map((service) => [
    service.manifest.slug, new Set(externalJobAdapterVersions(service)),
  ]));
  const missing = new Set<string>();
  for (const instance of await liveRuntimeInstances(db)) {
    const sales = instance.capabilities.externalJobSales;
    if (!sales || typeof sales !== "object" || Array.isArray(sales)) continue;
    for (const [slug, version] of Object.entries(sales as Record<string, unknown>)) {
      if (typeof version !== "string" || !resumable.get(slug)?.has(version)) missing.add(`${slug}@${String(version)}`);
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `running instances sell external-job adapter versions this build cannot resume: ${[...missing].sort().join(", ")}`,
    );
  }
}

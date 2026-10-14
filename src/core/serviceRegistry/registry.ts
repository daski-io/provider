import { adapterMode, assertServiceAdapters } from "./adapterValidation.js";
import {
  assertExternalJobDeadlines,
  assertSynchronousDeadlines,
  skillDeadlines,
} from "./deadlines.js";
import type {
  ExternalJobAdapter,
  FulfillmentAdapter,
  ServiceAdapter,
  ServiceModule,
  SkillDefinition,
} from "./types.js";

const services = new Map<string, ServiceModule>();

export function registerService(module: ServiceModule): void {
  const { manifest } = module;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.slug)) {
    throw new Error(`Invalid service slug: ${manifest.slug}`);
  }
  if (services.has(manifest.slug)) {
    throw new Error(`Service already registered: ${manifest.slug}`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.serviceType)) {
    throw new Error(`Invalid service type: ${manifest.serviceType}`);
  }
  if (
    manifest.jurisdictions.length === 0
    || new Set(manifest.jurisdictions).size !== manifest.jurisdictions.length
    || (manifest.jurisdictions.includes("global") && manifest.jurisdictions.length !== 1)
  ) {
    throw new Error(`Service ${manifest.slug} has invalid jurisdictions`);
  }
  if (!module.docs.service.trim()) {
    throw new Error(`Service ${manifest.slug} is missing service documentation`);
  }
  const failureCodes = module.failureCodes ?? [];
  if (
    !Array.isArray(failureCodes) || failureCodes.length > 64
    || new Set(failureCodes).size !== failureCodes.length
    || failureCodes.some((code) => typeof code !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(code))
  ) {
    throw new Error(`Service ${manifest.slug} has invalid reviewed failure codes`);
  }
  assertServiceAdapters(module);
  const skillIds = new Set<string>();
  for (const skill of module.skills) validateSkill(module, skill, skillIds);
  if (module.skills.length === 0) {
    throw new Error(`Service ${manifest.slug} must expose at least one skill`);
  }
  services.set(manifest.slug, module);
}

function validateSkill(
  module: ServiceModule,
  skill: SkillDefinition,
  skillIds: Set<string>,
): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.id) || skillIds.has(skill.id)) {
    throw new Error(`Service ${module.manifest.slug} has invalid or duplicate skill ${skill.id}`);
  }
  skillIds.add(skill.id);
  if (!/^[1-9]\d*$/.test(skill.fixedPriceAtomic)) {
    throw new Error(`Skill ${skill.id} must use a positive fixed USDC price`);
  }
  // Either mode's window must survive one lost dispatch; a job's window is
  // also its declared overdue threshold.
  const label = `Skill ${module.manifest.slug}/${skill.id}`;
  if (adapterMode(module.adapter) === "external-job") assertExternalJobDeadlines(label, skill);
  else assertSynchronousDeadlines(label, skillDeadlines(skill));
  if (!module.docs.skills[skill.id]?.trim()) {
    throw new Error(`Skill ${module.manifest.slug}/${skill.id} is missing documentation`);
  }
}

export function getService(slug: string): ServiceModule | null {
  return services.get(slug) ?? null;
}

export function getAllServices(): ServiceModule[] {
  return [...services.values()];
}

export function getSkill(serviceSlug: string, skillId: string): SkillDefinition | null {
  return getService(serviceSlug)?.skills.find((skill) => skill.id === skillId) ?? null;
}

/** The adapter new sales of the service use, in whichever mode. */
export function getAdapter(serviceSlug: string): ServiceAdapter {
  const module = getService(serviceSlug);
  if (!module) throw new Error(`Unknown service: ${serviceSlug}`);
  return module.adapter;
}

/** The service's synchronous adapter; an external-job service has none. */
export function getSyncAdapter(serviceSlug: string): FulfillmentAdapter {
  const adapter = getAdapter(serviceSlug);
  if (adapter.mode === "external-job") throw new Error(`Service ${serviceSlug} is not synchronous`);
  return adapter;
}

/**
 * The external-job adapter of exactly the version a job was admitted under:
 * the current adapter or a retained previous one; null when this build
 * cannot resume that version.
 */
export function getExternalJobAdapter(serviceSlug: string, version: string): ExternalJobAdapter | null {
  const module = getService(serviceSlug);
  if (!module) return null;
  if (module.adapter.mode === "external-job" && module.adapter.version === version) return module.adapter;
  const previous = module.previousExternalJobAdapters ?? {};
  return Object.hasOwn(previous, version) ? previous[version]! : null;
}

export function clearServicesForTests(): void {
  services.clear();
}

import type {
  FulfillmentAdapter,
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

export function getAdapter(serviceSlug: string): FulfillmentAdapter {
  const module = getService(serviceSlug);
  if (!module) throw new Error(`Unknown service: ${serviceSlug}`);
  return module.adapter;
}

export function clearServicesForTests(): void {
  services.clear();
}

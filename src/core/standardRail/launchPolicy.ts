import type { ServiceModule } from "../serviceRegistry/types.js";

export interface ProviderPaidSkillLaunchPolicy {
  serviceSlug: string;
  skillId: string;
}

export interface ProviderOutcomeLaunchPolicy {
  paidSkills: readonly ProviderPaidSkillLaunchPolicy[];
}

export function deriveProviderLaunchPolicy(
  services: readonly ServiceModule[],
): ProviderOutcomeLaunchPolicy {
  return {
    paidSkills: services.flatMap((service) => service.skills
      .filter((skill) => BigInt(skill.fixedPriceAtomic) > 0n)
      .map((skill) => ({
        serviceSlug: service.manifest.slug,
        skillId: skill.id,
      }))),
  };
}

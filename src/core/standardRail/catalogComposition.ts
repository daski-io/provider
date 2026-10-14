import { getAllServices, getSkill } from "../serviceRegistry/registry.js";
import type { ProviderStandardRailConfig } from "./config.js";

/**
 * Every head sells an installed paid skill of this build. A head whose price
 * differs from the build's is contract drift, not a boot failure: its new
 * quotes stop (commitmentDriftBoot.ts) while its funded orders, every other
 * listing and every read keep being served, at the admitted price.
 */
export function assertCatalogComposition(standard: ProviderStandardRailConfig): void {
  const configured = new Set<string>();
  for (const outcome of standard.outcomes.values()) {
    if (!getSkill(outcome.serviceSlug, outcome.skillId)) {
      throw new Error(`Outcome ${outcome.outcomeId} references an unknown service skill`);
    }
    configured.add(`${outcome.serviceSlug}/${outcome.skillId}`);
  }
  const installedPaid = new Set(getAllServices().flatMap((service) =>
    service.skills
      .filter((skill) => BigInt(skill.fixedPriceAtomic) > 0n)
      .map((skill) => `${service.manifest.slug}/${skill.id}`)));
  if ([...configured].some((key) => !installedPaid.has(key))) {
    throw new Error("Runtime catalog contains an uninstalled paid skill");
  }
}

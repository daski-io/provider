import type { Hex } from "viem";
import { config } from "../config.js";
import { canonicalHash } from "../standardRail/canonical.js";
import type { ServiceModule, SkillDefinition } from "../serviceRegistry/types.js";

export const DASKI_CONTRACT_EXTENSION_URI = "https://daski.io/a2a/v2";

export interface PublishedSkillContract {
  skillId: string;
  skillContractHash: Hex;
  presentation: {
    name: string;
    description: string;
    examples: string[];
    tags: string[];
    documentationUrl: string;
  };
  acceptingNewOrders: boolean;
  contract: Record<string, unknown>;
}

export interface MinimalContractExtension {
  schemaVersion: 1;
  providerAgentId: string;
  service: {
    serviceId: Hex | null;
    slug: string;
    version: string;
    categoryFamily: string;
    serviceType: string;
    jurisdictions: string[];
    lifecycle: "one-shot";
    turnaroundEstimate: string;
    acceptingNewOrders: boolean;
  };
  standardRail: {
    origin: string;
    providerAudience: string;
    quoteUrl: string;
    dispatchUrl: string;
    dispatchStatusUrl: string;
    lifecycleUrl: string;
    assetQueryUrl: string;
    assetActionUrl: string;
  };
  skillContractSetHash: Hex;
  skills: PublishedSkillContract[];
}

export function publishedSkillContract(
  service: ServiceModule,
  skill: SkillDefinition,
  baseUrl: string,
): PublishedSkillContract {
  const contract = {
    inputSchema: skill.inputSchema,
    resultSchema: skill.resultSchema,
    pricing: { USDC: { type: "one-time", fixed_amount: skill.fixedPriceAtomic } },
    requiresAssetOwnership: false,
    paymentRequired: BigInt(skill.fixedPriceAtomic) > 0n,
    assetType: null,
    fulfillmentMode: "automated",
    capacity: skill.capacity ?? { maxOpenOrders: 10 },
    deadlines: skill.deadlines ?? { dispatchSeconds: 300, fulfillmentSeconds: 50 },
    assetAction: null,
  };
  const skillContractHash = canonicalHash({
    schemaVersion: 1,
    serviceSlug: service.manifest.slug,
    serviceVersion: service.manifest.version,
    skillId: skill.id,
    contract,
  });
  return {
    skillId: skill.id,
    skillContractHash,
    acceptingNewOrders: skill.acceptingNewOrders ?? true,
    presentation: {
      name: skill.name,
      description: skill.description,
      examples: skill.examples,
      tags: skill.tags ?? [],
      documentationUrl: `${baseUrl}/skills/${service.manifest.slug}/${skill.id}.md`,
    },
    contract,
  };
}

export function buildContractExtension(
  service: ServiceModule,
  baseUrl: string,
  serviceId: Hex | null = null,
): MinimalContractExtension {
  const skills = service.skills
    .map((skill) => publishedSkillContract(service, skill, baseUrl))
    .sort((left, right) => left.skillId.localeCompare(right.skillId));
  const origin = new URL(baseUrl).origin;
  return {
    schemaVersion: 1,
    providerAgentId: config.PROVIDER_AGENT_ID.toString(),
    service: {
      serviceId,
      slug: service.manifest.slug,
      version: service.manifest.version,
      categoryFamily: service.manifest.categoryFamily,
      serviceType: service.manifest.serviceType,
      jurisdictions: service.manifest.jurisdictions,
      lifecycle: "one-shot",
      turnaroundEstimate: service.manifest.turnaroundEstimate,
      acceptingNewOrders: skills.some((skill) => skill.acceptingNewOrders),
    },
    standardRail: {
      origin,
      providerAudience: baseUrl,
      quoteUrl: `${origin}/standard-rail/quote`,
      dispatchUrl: `${origin}/standard-rail/dispatch`,
      dispatchStatusUrl: `${origin}/standard-rail/dispatch/status`,
      lifecycleUrl: `${origin}/standard-rail/lifecycle`,
      assetQueryUrl: `${origin}/standard-rail/assets/query`,
      assetActionUrl: `${origin}/standard-rail/assets/action`,
    },
    skillContractSetHash: canonicalHash(skills.map((skill) => ({
      skillId: skill.skillId,
      skillContractHash: skill.skillContractHash,
    }))),
    skills,
  };
}

export function serviceContractHash(extension: MinimalContractExtension): Hex {
  return canonicalHash({
    schemaVersion: 1,
    providerAgentId: extension.providerAgentId,
    service: {
      serviceId: extension.service.serviceId,
      slug: extension.service.slug,
      version: extension.service.version,
      categoryFamily: extension.service.categoryFamily,
      serviceType: extension.service.serviceType,
      jurisdictions: extension.service.jurisdictions,
      lifecycle: extension.service.lifecycle,
      acceptingNewOrders: extension.service.acceptingNewOrders,
    },
    standardRail: extension.standardRail,
    legal: {
      marketplaceTermsUrl: config.MARKETPLACE_TERMS_URL,
      marketplacePrivacyUrl: config.MARKETPLACE_PRIVACY_URL,
      providerLegalName: config.PROVIDER_NAME,
      providerTermsUrl: config.PROVIDER_TERMS_URL,
      providerPrivacyUrl: config.PROVIDER_PRIVACY_URL,
    },
    skillContractSetHash: extension.skillContractSetHash,
  });
}

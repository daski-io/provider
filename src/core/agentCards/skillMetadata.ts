import { config } from "../config.js";
import type { ServiceRow } from "../db/queries/services.js";
import type { SkillRow } from "../db/queries/skills.js";
import {
  getFloor,
  isFree,
  isVariable,
  type CurrencyPricing,
  type SkillPricing,
} from "../pricing/index.js";
import type { A2ASkill } from "./types.js";

export const DEFAULT_MODES = ["text/plain", "application/json"];
const PRIMARY_CURRENCY = "USDC";

export function buildSkillEntries(
  service: ServiceRow,
  skills: SkillRow[],
): A2ASkill[] {
  return skills.map((skill) => ({
    id: skill.skill_id,
    name: skill.name,
    description: skill.description,
    tags: [
      service.category_family,
      service.service_type,
      isFree(skill.pricing, PRIMARY_CURRENCY) ? "free" : "paid",
      ...parseStringArray(skill.tags),
    ],
    examples: parseStringArray(skill.examples),
    documentationUrl: skill.documentation_url
      ?? `${config.BASE_URL}/skills/${service.slug}/${skill.skill_id}.md`,
    inputModes: DEFAULT_MODES,
    outputModes: DEFAULT_MODES,
  }));
}

export function buildSkillMetadata(
  service: ServiceRow,
  skills: SkillRow[],
): Record<string, unknown> {
  return Object.fromEntries(skills.map((skill) => {
    const free = isFree(skill.pricing, PRIMARY_CURRENCY);
    const optionalFields = skill.optional_fields;
    return [skill.skill_id, {
      serviceSlug: service.slug,
      serviceVersion: service.version,
      paymentRequired: !free,
      variablePricing: isVariable(skill.pricing, PRIMARY_CURRENCY),
      currency: PRIMARY_CURRENCY,
      requiresAssetOwnership: skill.requires_asset_ownership,
      access: free && !skill.requires_asset_ownership
        ? "open-free-a2a"
        : "gateway-managed-wallet",
      fulfillmentMode: skill.fulfillment_mode,
      ...(skill.human_parties ? { humanParties: skill.human_parties } : {}),
      assetType: skill.asset_type,
      requiredFields: skill.required_fields,
      ...(optionalFields && optionalFields.length > 0
        ? { optionalFields }
        : {}),
      pricing: translatePricingForGateway(skill.pricing),
    }];
  }));
}

function translatePricingForGateway(
  pricing: SkillPricing,
): Record<string, unknown> {
  const currency: CurrencyPricing | undefined = pricing[PRIMARY_CURRENCY];
  if (!currency) return {};
  const result: Record<string, unknown> = { type: currency.type };
  if (currency.fixed_amount !== undefined) {
    result.baseAmount = currency.fixed_amount;
  } else {
    const floor = getFloor(pricing, PRIMARY_CURRENCY);
    if (floor !== null) result.baseAmount = floor.toString();
  }
  if (currency.price_list) result.priceList = currency.price_list;
  if (currency.min_amount) result.minAmount = currency.min_amount;
  if (currency.max_amount) result.maxAmount = currency.max_amount;
  if (currency.interval) result.interval = currency.interval;
  if (currency.unit) result.unit = currency.unit;
  if (currency.amount_per_unit) result.amountPerUnit = currency.amount_per_unit;
  return result;
}

function parseStringArray(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.filter((value): value is string => typeof value === "string");
  }
  if (typeof input !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(input);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

import { config } from "../config.js";
import type { ServiceRow } from "../db/queries/services.js";
import type { SkillRow } from "../db/queries/skills.js";
import { isPaymentRequired, isVariable } from "../pricing/index.js";
import { getService } from "../serviceRegistry/registry.js";
import type { AssetTypeLifecycle } from "../serviceRegistry/types.js";
import type { AgentCardSupport } from "./types.js";

const PRIMARY_CURRENCY = "USDC";

export function buildServicePricing(skills: SkillRow[]): Record<string, unknown> {
  const priceable = skills.filter((skill) =>
    isPaymentRequired(skill.pricing, PRIMARY_CURRENCY),
  );
  const variable = priceable.some((skill) =>
    isVariable(skill.pricing, PRIMARY_CURRENCY),
  );
  const fixedAmounts = priceable.map(
    (skill) => skill.pricing[PRIMARY_CURRENCY]?.fixed_amount,
  );
  const uniformFixedAmount =
    !variable
    && fixedAmounts.length > 0
    && fixedAmounts.every(
      (amount): amount is string => typeof amount === "string" && amount !== "0",
    )
    && new Set(fixedAmounts).size === 1
      ? fixedAmounts[0]
      : null;
  return {
    currency: PRIMARY_CURRENCY,
    variablePricing: variable,
    variable,
    billingModel: "one-time",
    ...(variable ? { model: "live" } : {}),
    ...(uniformFixedAmount ? { baseAmount: uniformFixedAmount } : {}),
  };
}

export function buildSupportBlock(service: ServiceRow): AgentCardSupport {
  const support = getService(service.slug)?.manifest.support;
  return {
    email: service.outbound_email_from || config.SUPPORT_EMAIL,
    responseSla: config.SUPPORT_RESPONSE_SLA,
    emailAuthoritativeFor: support?.emailAuthoritativeFor ?? [],
    skillRequiredFor: support?.skillRequiredFor ?? [],
  };
}

export function collectAssetTypes(
  service: ServiceRow,
  skills: SkillRow[],
): Record<string, AssetTypeLifecycle> {
  const lifecycle = getService(service.slug)?.manifest.assetLifecycle ?? {};
  const result: Record<string, AssetTypeLifecycle> = {};
  for (const skill of skills) {
    if (!skill.asset_type) continue;
    const entry = lifecycle[skill.asset_type];
    if (entry) result[skill.asset_type] = entry;
  }
  return result;
}

import type { ServiceRow } from "../../../../db/queries/services.js";
import type { SkillRow } from "../../../../db/queries/skills.js";
import {
  getFloor,
  isFree,
  isPaymentRequired,
  isVariable,
  parseUsdcDecimal,
} from "../../../../pricing/index.js";
import { formatUsdc } from "../../../../utils/format.js";
import { escapeAttr, escapeHtml, mono, pill } from "../../layouts.js";

export type PricingMode = "fixed" | "dynamic" | "none";

export interface PricingModeInfo {
  mode: PricingMode;
  paidSkills: SkillRow[];
  fixedUsd: string | null;
}

export function pricingModeOf(skills: SkillRow[]): PricingModeInfo {
  const paidSkills = skills.filter(
    (skill) => skill.is_active && isPaymentRequired(skill.pricing),
  );
  if (paidSkills.length === 0) {
    return { mode: "none", paidSkills, fixedUsd: null };
  }
  if (paidSkills.some((skill) => isVariable(skill.pricing))) {
    return { mode: "dynamic", paidSkills, fixedUsd: null };
  }
  const first = paidSkills[0]?.pricing.USDC?.fixed_amount;
  const fixedUsd = typeof first === "string" && /^[0-9]+$/.test(first)
    ? (Number(first) / 1_000_000).toFixed(2)
    : null;
  return { mode: "fixed", paidSkills, fixedUsd };
}

// Convert a two-decimal USD input to atomic USDC without a float round-trip.
export function usdStringToAtomic(input: string): bigint | null {
  return parseUsdcDecimal(input, 2);
}

function skillPrice(skill: SkillRow): string {
  if (isFree(skill.pricing)) return pill("free", "success");
  const floor = getFloor(skill.pricing);
  if (isVariable(skill.pricing)) {
    return floor === null
      ? pill("live quote", "info")
      : `${mono(formatUsdc(floor))} <span class="dim">+ variable</span>`;
  }
  return floor === null ? pill("unknown", "warning") : mono(formatUsdc(floor));
}

function pricingModelCard(
  service: ServiceRow,
  info: PricingModeInfo,
  markupManaged: boolean,
): string {
  if (info.mode === "fixed") {
    return `<section class="card workspace-card">
      <div class="workspace-card-head">
        <div class="mono-caption">Pricing model</div>
        ${pill("fixed", "neutral")}
      </div>
      <form method="POST" action="/admin/ui/config/services/${escapeAttr(service.id)}/pricing" class="inline-settings-form">
        <label class="field-group">
          <span class="field-label">Price (USD)</span>
          <input class="input mono compact-input" name="fixed_price_usd" inputmode="decimal"
            value="${escapeAttr(info.fixedUsd ?? "")}" placeholder="9.99" required>
        </label>
        <button class="btn btn--primary" type="submit">Save price</button>
      </form>
      <p class="workspace-note">Applies to ${info.paidSkills.length} paid skill${info.paidSkills.length === 1 ? "" : "s"}: <span class="mono">${info.paidSkills.map((skill) => escapeHtml(skill.skill_id)).join(" · ")}</span>.</p>
    </section>`;
  }

  if (info.mode === "dynamic") {
    const tab = markupManaged ? "controls" : "supplier";
    const destination = markupManaged ? "service controls" : "supplier settings";
    return `<section class="card workspace-card">
      <div class="workspace-card-head">
        <div class="mono-caption">Pricing model</div>
        ${pill("dynamic", "neutral")}
      </div>
      <p class="workspace-copy">Prices are quoted live from the supplier for each request. Retail pricing is wholesale × (1 + markup)${markupManaged ? " plus any service-managed fee" : ""}; the committed quote remains the charged amount.</p>
      <a class="btn" href="/admin/ui/services/${escapeAttr(service.id)}?tab=${tab}">Open ${destination}</a>
    </section>`;
  }

  return `<section class="card workspace-card">
    <div class="workspace-card-head">
      <div class="mono-caption">Pricing model</div>
      ${pill("free", "success")}
    </div>
    <p class="workspace-copy">Every active skill on this service is free.</p>
  </section>`;
}

export function renderPricingTab(args: {
  service: ServiceRow;
  skills: SkillRow[];
  markupManaged: boolean;
}): string {
  const info = pricingModeOf(args.skills);
  const rows = args.skills.map((skill) => {
    const flags = [
      skill.requires_asset_ownership ? pill("ownership", "info") : "",
    ].filter(Boolean).join(" ");
    return `<tr>
      <td>
        <strong>${escapeHtml(skill.name)}</strong>
        <div class="mono service-row-meta">${escapeHtml(skill.skill_id)}</div>
      </td>
      <td>${flags || '<span class="dim">—</span>'}</td>
      <td class="number-cell">${skillPrice(skill)}</td>
      <td class="number-cell">${skill.is_active ? pill("active", "success") : pill("inactive", "neutral")}</td>
    </tr>`;
  }).join("");

  return `<div class="workspace-stack">
    ${pricingModelCard(args.service, info, args.markupManaged)}
    <section>
      <div class="section-heading">
        <div class="mono-caption">Skills · provider_skills.pricing</div>
        <span class="mono dim">${args.skills.length} total</span>
      </div>
      <div class="card workspace-table-card">
        <div class="table-scroll">
          <table class="workspace-table">
            <thead><tr><th>Skill</th><th>Flags</th><th class="number-cell">Price</th><th class="number-cell">Status</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
      <p class="workspace-note">Owner-only operations require gateway-verified payer-wallet authority.</p>
    </section>
  </div>`;
}

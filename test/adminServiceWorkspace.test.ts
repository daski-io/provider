import { describe, expect, it } from "vitest";
import type { SkillRow } from "../src/core/db/queries/skills.js";
import { renderLayout } from "../src/core/admin/ui/layouts.js";
import {
  parseServiceWorkspaceTab,
  serviceWorkspaceUrl,
} from "../src/core/admin/ui/pages/services/navigation.js";
import {
  pricingModeOf,
  usdStringToAtomic,
} from "../src/core/admin/ui/pages/services/pricing.js";
import type { SkillPricing } from "../src/core/pricing/index.js";

function skill(pricing: SkillPricing, active = true): SkillRow {
  return {
    id: crypto.randomUUID(),
    skill_id: "test-skill",
    pricing,
    is_active: active,
  } as SkillRow;
}

describe("combined Services workspace", () => {
  it("keeps Services in navigation and removes the separate Config entry", () => {
    const html = renderLayout({
      page: "services",
      title: "Services",
      body: "",
      contentClass: "content--services",
    });

    expect(html).toContain('class="active" href="/admin/ui/services"');
    expect(html).not.toContain('href="/admin/ui/config"');
    expect(html).toContain('/admin/ui/static/services.css');
    expect(html).toContain('/admin/ui/static/service-workspace.css');
    expect(html.indexOf("<style>")).toBeLessThan(
      html.indexOf('/admin/ui/static/services.css'),
    );
    expect(html).toContain('name="viewport"');
  });

  it("accepts only known service tabs", () => {
    expect(parseServiceWorkspaceTab("rules")).toBe("rules");
    expect(parseServiceWorkspaceTab("unknown")).toBe("overview");
    expect(parseServiceWorkspaceTab(["rules"])).toBe("overview");
  });

  it("builds encoded service URLs with tab-scoped flash messages", () => {
    expect(serviceWorkspaceUrl("service/one", "pricing", {
      kind: "ok",
      message: "Price updated.",
    })).toBe(
      "/admin/ui/services/service%2Fone?tab=pricing&ok=Price+updated.",
    );
  });

  it("preserves fixed, dynamic, and free pricing modes", () => {
    const fixed = skill({ USDC: { type: "one-time", fixed_amount: "9990000" } });
    const free = skill({ USDC: { type: "one-time", fixed_amount: "0" } });
    const dynamic = skill({
      USDC: { type: "one-time", min_amount: "1000000", max_amount: "5000000" },
    });

    expect(pricingModeOf([fixed, free])).toMatchObject({
      mode: "fixed",
      fixedUsd: "9.99",
    });
    expect(pricingModeOf([fixed, dynamic])).toMatchObject({ mode: "dynamic" });
    expect(pricingModeOf([free])).toMatchObject({ mode: "none" });
  });

  it("parses USD input using atomic string math", () => {
    expect(usdStringToAtomic("9.99")).toBe(9_990_000n);
    expect(usdStringToAtomic("10")).toBe(10_000_000n);
    expect(usdStringToAtomic("0")).toBeNull();
    expect(usdStringToAtomic("1.999")).toBeNull();
  });
});

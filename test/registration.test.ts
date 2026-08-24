import { describe, it, expect, vi } from "vitest";
import type { ServiceRow } from "../src/core/db/queries/services.js";

// Pin env BEFORE the module under test imports config — the registration
// generator reads PROVIDER_NAME / PROVIDER_DESCRIPTION / PROVIDER_ICON_URL
// / PROVIDER_WEBSITE_URL at module load. test/setup.ts already sets
// PROVIDER_NAME=Test Provider; we layer the icon + website here.
process.env.BASE_URL = "https://provider.test";
// A public BASE_URL is only legal outside mock chain mode (mock binds to
// loopback), so pin live mode against ambient CI env.
process.env.CHAIN_MODE = "live";
process.env.PROVIDER_WEBSITE_URL = "https://provider.test/about";
process.env.PROVIDER_ICON_URL = "https://provider.test/icon.png";

const { generateRegistrationFile, buildAgentRegistryId } = await import(
  "../src/core/agentCards/registration.js"
);

function makeService(overrides: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: "svc-1",
    name: "Sample Service",
    slug: "dummy",
    version: "1",
    category_family: "other",
    service_type: "dummy",
    jurisdictions: ["global"],
    turnaround_estimate: "5-10 minutes",
    service_lifecycle: "asset-lifecycle",
    service_description: "Create and manage sample items.",
    adapter_name: "dummy",
    agent_domain: "provider.test",
    supplier: "sample-supplier",
    outbound_email_from: null,
    inbound_email_address: null,
    on_chain_id: null,
    service_wallet: null,
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
    config_revision: "0",
    operator_updated_by: null,
    operator_updated_at: null,
    ...overrides,
  };
}

const REGISTRY = buildAgentRegistryId(
  84532,
  "0x52B93497B6ADd797BD5d70c611Cc31E24Ed28e19",
);

describe("ERC-8004 registration file", () => {
  it("emits the v1 type URI and required structural fields", () => {
    const file = generateRegistrationFile([makeService()], {
      agentRegistry: REGISTRY,
    });
    expect(file.type).toBe(
      "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    );
    expect(file.name).toBe("Test Provider");
    expect(file.legalName).toBe("Test Provider");
    expect(file.termsUrl).toBe("https://provider.test/terms-of-use");
    expect(file.privacyUrl).toBe("https://provider.test/privacy-policy");
    expect(file.services).toHaveLength(2);
    expect(file.services[0]).toMatchObject({
      name: "MCP",
      endpoint: "https://gateway.test/mcp",
    });
    expect(file.services[1].name).toBe("A2A");
    expect(file.services[1].endpoint).toBe(
      "https://provider.test/agent-cards/dummy.json",
    );
    expect(file.registrations).toHaveLength(1);
    expect(file.registrations[0].agentRegistry).toBe(REGISTRY);
  });

  it("lists one A2A entry per active service (multi-service provider)", () => {
    // The gateway's discovery cache fetches EVERY services[name="A2A"]
    // entry and catalogs each service separately — a provider offering
    // dummy + sample-secondary must advertise both here or the
    // second service is invisible to the marketplace.
    const file = generateRegistrationFile(
      [
        makeService(),
        makeService({ id: "svc-2", slug: "sample-secondary", name: "Secondary Sample" }),
      ],
      { agentRegistry: REGISTRY },
    );
    expect(file.services).toHaveLength(3);
    expect(file.services.filter((s) => s.name === "A2A").map((s) => s.endpoint)).toEqual([
      "https://provider.test/agent-cards/dummy.json",
      "https://provider.test/agent-cards/sample-secondary.json",
    ]);
    expect(file.services.filter((s) => s.name === "A2A")).toHaveLength(2);
    // One provider identity + one on-chain registration regardless of
    // how many services are listed.
    expect(file.name).toBe("Test Provider");
    expect(file.registrations).toHaveLength(1);
    expect(file.active).toBe(true);
  });

  it("is active when ANY listed service is active", () => {
    const file = generateRegistrationFile(
      [
        makeService({ is_active: false }),
        makeService({ id: "svc-2", slug: "sample-secondary", is_active: true }),
      ],
      { agentRegistry: REGISTRY },
    );
    expect(file.active).toBe(true);
    const none = generateRegistrationFile(
      [makeService({ is_active: false })],
      { agentRegistry: REGISTRY },
    );
    expect(none.active).toBe(false);
  });

  it("surfaces PROVIDER_ICON_URL as `image` (ERC-721/ERC-8004 §registration-v1)", () => {
    // The spec lists name/description/image as SHOULD fields "to ensure
    // compatibility with ERC-721 apps" — identity-registry NFT viewers
    // consume them directly. Image is the only standard slot for a brand
    // mark on the registration file.
    const file = generateRegistrationFile([makeService()], {
      agentRegistry: REGISTRY,
    });
    expect(file.image).toBe("https://provider.test/icon.png");
  });

  it("surfaces PROVIDER_WEBSITE_URL as `external_url` (ERC-721 homepage convention)", () => {
    // ERC-8004 doesn't standardize a website slot, but `external_url` is
    // the universally-recognized ERC-721/OpenSea field for a project's
    // homepage. Adopting it keeps NFT-aware indexers happy without a
    // Daski-specific extension.
    const file = generateRegistrationFile([makeService()], {
      agentRegistry: REGISTRY,
    });
    expect(file.external_url).toBe("https://provider.test/about");
  });

  it("omits image / external_url when the corresponding env is unset", async () => {
    // config.ts parses process.env at module load, so we have to reset
    // the module graph and re-evaluate with the relevant vars cleared
    // before the re-import. vi.resetModules() drops the registry; the
    // try/finally restores the env so later test files see the values
    // test/setup.ts and the top of this file installed.
    const prevIcon = process.env.PROVIDER_ICON_URL;
    const prevSite = process.env.PROVIDER_WEBSITE_URL;
    delete process.env.PROVIDER_ICON_URL;
    delete process.env.PROVIDER_WEBSITE_URL;
    vi.resetModules();
    try {
      const fresh = await import("../src/core/agentCards/registration.js");
      const file = fresh.generateRegistrationFile([makeService()], {
        agentRegistry: REGISTRY,
      });
      expect(file.image).toBeUndefined();
      expect(file.external_url).toBeUndefined();
    } finally {
      if (prevIcon !== undefined) process.env.PROVIDER_ICON_URL = prevIcon;
      if (prevSite !== undefined) process.env.PROVIDER_WEBSITE_URL = prevSite;
      vi.resetModules();
    }
  });
});

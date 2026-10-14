import { afterEach, describe, expect, it, vi } from "vitest";

const catalog = vi.hoisted(() => ({ heads: [] as unknown[] }));
vi.mock("../src/core/gatewayRegistration/runtimeCatalog.js", () => ({
  loadRuntimeListingHeads: async () => catalog.heads,
}));

import { buildContractExtension } from "../src/core/agentCards/contractExtension.js";
import { stopSalesOnCommitmentDrift } from "../src/core/gatewayRegistration/commitmentDriftBoot.js";
import { clearSalesStopsForTests, salesStopFor } from "../src/core/standardRail/salesStops.js";
import { dummyService } from "../src/services/dummy/index.js";

const SERVICE = `0x${"8e".repeat(32)}` as const;
const served = buildContractExtension(dummyService, "https://provider.test", SERVICE)
  .skills.find((skill) => skill.skillId === "echo")!.skillContractHash;
const head = (listingByte: string, skillContractHash: string) => ({
  gatewayOrigin: "https://gateway.example",
  serviceId: SERVICE,
  skillId: "echo",
  runtimeCommitmentHash: `0x${listingByte.repeat(32)}`,
  runtimeCommitment: { skillContractHash },
  bundle: { intent: { payload: { serviceSlug: "dummy" } } },
});

afterEach(() => clearSalesStopsForTests());

describe("listing commitment drift at boot", () => {
  it("stops new sales of a drifted head with a stable diagnostic and leaves matching heads open", async () => {
    catalog.heads = [head("d1", `0x${"aa".repeat(32)}`), head("d2", served)];
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const drifts = await stopSalesOnCommitmentDrift({
        gatewayOrigin: "https://gateway.example", baseUrl: "https://provider.test", services: [dummyService],
      });
      expect(drifts.map((drift) => drift.listingManifestHash)).toEqual([`0x${"d1".repeat(32)}`]);
    } finally {
      spy.mockRestore();
    }
    expect(salesStopFor(`0x${"d1".repeat(32)}`)).toBe("contract_drift");
    expect(salesStopFor(`0x${"d2".repeat(32)}`)).toBeNull();
    expect(lines.join("")).toContain('"diagnostic":"listing_contract_drift"');
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearServicesForTests,
  getAdapter,
  getAllServices,
  getSkill,
  registerService,
} from "../src/core/serviceRegistry/registry.js";
import { dummyService } from "../src/services/dummy/index.js";

describe("minimal service registry", () => {
  beforeEach(clearServicesForTests);

  it("registers a documented fixed-price service in memory", () => {
    registerService(dummyService);
    expect(getAllServices()).toEqual([dummyService]);
    expect(getSkill("dummy", "echo")?.fixedPriceAtomic).toBe("10000");
    expect(getAdapter("dummy")).toBe(dummyService.adapter);
  });

  it("rejects duplicate services, invalid prices, and missing docs", () => {
    registerService(dummyService);
    expect(() => registerService(dummyService)).toThrow(/already registered/);
    clearServicesForTests();
    expect(() => registerService({
      ...dummyService,
      skills: [{ ...dummyService.skills[0]!, fixedPriceAtomic: "0" }],
    })).toThrow(/positive fixed/);
    expect(() => registerService({
      ...dummyService,
      docs: { service: "", skills: dummyService.docs.skills },
    })).toThrow(/missing service documentation/);
  });
});

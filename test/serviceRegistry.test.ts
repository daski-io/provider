import { beforeEach, describe, expect, it } from "vitest";
import {
  minimumSynchronousFulfillmentSeconds,
  skillDeadlines,
} from "../src/core/serviceRegistry/deadlines.js";
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

  it("refuses a synchronous window too short to recover a lost dispatch", () => {
    const withDeadlines = (deadlines: { dispatchSeconds?: number; fulfillmentSeconds?: number }) => ({
      ...dummyService,
      skills: [{ ...dummyService.skills[0]!, deadlines }],
    });
    // dispatchSeconds + 60 s no-claim grace + 50 s budget + 120 s reviewed margin.
    expect(minimumSynchronousFulfillmentSeconds(300)).toBe(530);
    for (const deadlines of [
      { dispatchSeconds: 300, fulfillmentSeconds: 50 },
      { dispatchSeconds: 300, fulfillmentSeconds: 529 },
      { dispatchSeconds: 600, fulfillmentSeconds: 829 },
      { dispatchSeconds: 700 },
      { dispatchSeconds: 29, fulfillmentSeconds: 900 },
      { dispatchSeconds: 300, fulfillmentSeconds: 31_536_001 },
      { dispatchSeconds: 300.5, fulfillmentSeconds: 900 },
    ]) {
      clearServicesForTests();
      expect(() => registerService(withDeadlines(deadlines)), JSON.stringify(deadlines)).toThrow();
    }
    for (const deadlines of [
      { dispatchSeconds: 300, fulfillmentSeconds: 530 },
      { dispatchSeconds: 600, fulfillmentSeconds: 830 },
      { fulfillmentSeconds: 530 },
      {},
    ]) {
      clearServicesForTests();
      expect(() => registerService(withDeadlines(deadlines))).not.toThrow();
    }
    expect(skillDeadlines({})).toEqual({ dispatchSeconds: 300, fulfillmentSeconds: 900 });
  });
});

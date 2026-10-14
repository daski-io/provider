import { afterEach, describe, expect, it } from "vitest";
import { clearServicesForTests, registerService } from "../src/core/serviceRegistry/registry.js";
import { assertCatalogComposition } from "../src/core/standardRail/catalogComposition.js";
import { echoService, railConfig, railOutcome } from "./standardRailServiceFixture.js";

afterEach(() => clearServicesForTests());

describe("runtime catalog composition at boot", () => {
  it("keeps booting when a head's admitted price differs from the build's (contract drift)", () => {
    registerService(echoService());
    expect(() => assertCatalogComposition(railConfig([railOutcome({ fixedGrossAmount: "20000" })])))
      .not.toThrow();
  });

  it("refuses a head for a skill this build does not install", () => {
    registerService(echoService());
    expect(() => assertCatalogComposition(railConfig([railOutcome({ skillId: "retired" })])))
      .toThrow(/references an unknown service skill/);
  });
});

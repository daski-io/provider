import { beforeEach, describe, expect, it } from "vitest";
import {
  clearServicesForTests,
  registerService,
} from "../src/core/serviceRegistry/registry.js";
import { deriveProviderLaunchPolicy } from "../src/core/standardRail/launchPolicy.js";
import { configuredServices } from "../src/providerServices.js";

describe("provider composition", () => {
  beforeEach(clearServicesForTests);

  it("installs only the dummy service and one reviewed outcome on Testnet", () => {
    const services = configuredServices(84532);
    services.forEach(registerService);
    expect(services.map((service) => service.manifest.slug)).toEqual(["dummy"]);
    expect(services[0]?.skills.map((skill) => skill.id)).toEqual(["echo"]);
    expect(deriveProviderLaunchPolicy(services).paidSkills).toEqual([
      { serviceSlug: "dummy", skillId: "echo" },
    ]);
  });

  it("cannot boot the dummy on Base mainnet", () => {
    expect(() => configuredServices(8453)).toThrow(/dummy service/);
  });
});

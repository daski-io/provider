import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkDatabase: vi.fn(),
  getAllServices: vi.fn(),
}));

vi.mock("../src/core/db/pool.js", () => ({
  checkDatabase: mocks.checkDatabase,
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAllServices: mocks.getAllServices,
}));

import {
  providerReady,
  setProviderIdentityStatus,
  setRailStatus,
} from "../src/core/health.js";

const service = (readiness: () => Promise<boolean>) => ({ readiness });

describe("paid-traffic readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setProviderIdentityStatus(true);
    setRailStatus(true);
    mocks.checkDatabase.mockResolvedValue(true);
    mocks.getAllServices.mockReturnValue([service(async () => true)]);
  });

  it("requires database and service readiness", async () => {
    await expect(providerReady()).resolves.toBe(true);

    setRailStatus(true);
    mocks.checkDatabase.mockResolvedValue(false);
    await expect(providerReady()).resolves.toBe(false);

    setRailStatus(true);
    mocks.checkDatabase.mockResolvedValue(true);
    mocks.getAllServices.mockReturnValue([service(async () => false)]);
    await expect(providerReady()).resolves.toBe(false);
  });

  it("fails closed when a product readiness check throws", async () => {
    mocks.getAllServices.mockReturnValue([service(async () => {
      throw new Error("product details must not escape");
    })]);
    await expect(providerReady()).resolves.toBe(false);
  });

  it("does not probe dependencies while identity or rail evidence is stale", async () => {
    setProviderIdentityStatus(false);
    await expect(providerReady()).resolves.toBe(false);
    expect(mocks.checkDatabase).not.toHaveBeenCalled();
  });
});

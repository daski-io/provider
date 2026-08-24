import { describe, expect, it, vi } from "vitest";
import { verifyRuntimeChainTrust } from "../src/core/chain/runtimeTrust.js";

const clientMocks = vi.hoisted(() => ({
  getChainId: vi.fn(async () => 8453),
  getCode: vi.fn(async () => "0x6000" as const),
}));

vi.mock("../src/core/config.js", () => ({
  config: {
    CHAIN_ID: 8453,
    IDENTITY_REGISTRY_ADDRESS: "0x1000000000000000000000000000000000000001",
    SERVICE_REGISTRY_ADDRESS: "0x1000000000000000000000000000000000000003",
    USDC_ADDRESS: "0x1000000000000000000000000000000000000004",
  },
}));

vi.mock("../src/core/chain/client.js", () => ({
  CHAIN_MODE_MOCK: false,
  publicClient: {
    getChainId: clientMocks.getChainId,
    getCode: clientMocks.getCode,
  },
}));

const CONTRACTS = [
  {
    label: "ServiceRegistry",
    address: "0x1111111111111111111111111111111111111111" as const,
  },
  {
    label: "USDC",
    address: "0x2222222222222222222222222222222222222222" as const,
  },
];

function dependencies(patch: Record<string, unknown> = {}) {
  return {
    mock: false,
    expectedChainId: 8453,
    contracts: CONTRACTS,
    getChainId: vi.fn(async () => 8453),
    getCode: vi.fn(async () => "0x6000" as const),
    ...patch,
  };
}

describe("runtime chain trust", () => {
  it("rejects an RPC serving a different chain before reading contracts", async () => {
    const deps = dependencies({
      getChainId: vi.fn(async () => 84532),
    });
    await expect(verifyRuntimeChainTrust(deps))
      .rejects.toThrow("RPC chain id 84532");
    expect(deps.getCode).not.toHaveBeenCalled();
  });

  it("rejects configured contracts without deployed bytecode", async () => {
    const deps = dependencies({
      getCode: vi.fn(async (address: string) =>
        address === CONTRACTS[0].address ? "0x" : "0x6000"),
    });
    await expect(verifyRuntimeChainTrust(deps))
      .rejects.toThrow("ServiceRegistry has no deployed code");
  });

  it("accepts only after every configured contract has code", async () => {
    const deps = dependencies();
    await expect(verifyRuntimeChainTrust(deps)).resolves.toBeUndefined();
    expect(deps.getCode).toHaveBeenCalledTimes(CONTRACTS.length);
  });

  it("keeps isolated mock mode free of live chain reads", async () => {
    const deps = dependencies({ mock: true });
    await expect(verifyRuntimeChainTrust(deps)).resolves.toBeUndefined();
    expect(deps.getChainId).not.toHaveBeenCalled();
    expect(deps.getCode).not.toHaveBeenCalled();
  });

  it("wires the startup default to viem chain id and bytecode reads", async () => {
    clientMocks.getChainId.mockClear();
    clientMocks.getCode.mockClear();

    await expect(verifyRuntimeChainTrust()).resolves.toBeUndefined();

    expect(clientMocks.getChainId).toHaveBeenCalledOnce();
    expect(clientMocks.getCode).toHaveBeenCalledTimes(3);
    expect(clientMocks.getCode).toHaveBeenCalledWith({
      address: "0x1000000000000000000000000000000000000003",
    });
  });
});

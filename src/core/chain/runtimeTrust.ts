import type { Hex } from "viem";
import { config } from "../config.js";
import { CHAIN_MODE_MOCK, publicClient } from "./client.js";

interface RuntimeTrustDependencies {
  mock: boolean;
  expectedChainId: number;
  contracts: Array<{ label: string; address: Hex }>;
  getChainId(): Promise<number>;
  getCode(address: Hex): Promise<Hex | undefined>;
}

export async function verifyRuntimeChainTrust(
  dependencies: RuntimeTrustDependencies = {
    mock: CHAIN_MODE_MOCK,
    expectedChainId: config.CHAIN_ID,
    contracts: [
      { label: "IdentityRegistry", address: config.IDENTITY_REGISTRY_ADDRESS as Hex },
      { label: "USDC", address: config.USDC_ADDRESS as Hex },
    ],
    getChainId: () => publicClient.getChainId() as Promise<number>,
    getCode: (address) =>
      publicClient.getCode({ address }) as Promise<Hex | undefined>,
  },
): Promise<void> {
  if (dependencies.mock) return;
  const actualChainId = await dependencies.getChainId();
  if (actualChainId !== dependencies.expectedChainId) {
    throw new Error(
      `RPC chain id ${actualChainId} does not match configured chain id ${dependencies.expectedChainId}`,
    );
  }
  await Promise.all(dependencies.contracts.map(async ({ label, address }) => {
    const code = await dependencies.getCode(address);
    if (!code || code === "0x") {
      throw new Error(`${label} has no deployed code at ${address}`);
    }
  }));
}

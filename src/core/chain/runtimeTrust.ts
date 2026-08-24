import type { Hex } from "viem";
import { config } from "../config.js";
import {
  CHAIN_MODE_MOCK,
  publicClient,
} from "./client.js";

interface RuntimeContract {
  label: string;
  address: Hex;
}

interface RuntimeChainTrustDependencies {
  mock: boolean;
  expectedChainId: number;
  contracts: RuntimeContract[];
  getChainId(): Promise<number>;
  getCode(address: Hex): Promise<Hex | undefined>;
}

const defaults: RuntimeChainTrustDependencies = {
  mock: CHAIN_MODE_MOCK,
  expectedChainId: config.CHAIN_ID,
  contracts: [
    {
      label: "IdentityRegistry",
      address: config.IDENTITY_REGISTRY_ADDRESS as Hex,
    },
    {
      label: "ServiceRegistry",
      address: config.SERVICE_REGISTRY_ADDRESS as Hex,
    },
    { label: "USDC", address: config.USDC_ADDRESS as Hex },
  ],
  getChainId: () => publicClient.getChainId(),
  getCode: (address) => publicClient.getCode({ address }),
};

export async function verifyRuntimeChainTrust(
  dependencies: RuntimeChainTrustDependencies = defaults,
): Promise<void> {
  if (dependencies.mock) return;

  const actualChainId = await dependencies.getChainId();
  if (actualChainId !== dependencies.expectedChainId) {
    throw new Error(
      `RPC chain id ${actualChainId} does not match configured chain id ` +
        dependencies.expectedChainId,
    );
  }

  await Promise.all(dependencies.contracts.map(async (contract) => {
    const code = await dependencies.getCode(contract.address);
    if (!code || code === "0x") {
      throw new Error(
        `${contract.label} has no deployed code at ${contract.address} ` +
          `on chain ${actualChainId}`,
      );
    }
  }));
}

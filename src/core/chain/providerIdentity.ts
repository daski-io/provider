import type { Hex } from "viem";
import { config } from "../config.js";
import { setProviderIdentityStatus } from "../health.js";
import { errorExtra, logWarn } from "../logger.js";
import { identityRegistryAbi } from "./abis.js";
import {
  CHAIN_MODE_MOCK,
  providerAddress,
  publicClient,
} from "./client.js";

export async function verifyProviderIdentity(): Promise<boolean> {
  if (CHAIN_MODE_MOCK) return true;
  const registered = await publicClient.readContract({
    address: config.IDENTITY_REGISTRY_ADDRESS as Hex,
    abi: identityRegistryAbi,
    functionName: "getAgentWallet",
    args: [config.PROVIDER_AGENT_ID],
  });
  return String(registered).toLowerCase() === providerAddress.toLowerCase();
}

export async function startProviderIdentityMonitor(): Promise<() => void> {
  const refresh = async (): Promise<boolean> => {
    try {
      const verified = await verifyProviderIdentity();
      setProviderIdentityStatus(verified);
      return verified;
    } catch (error) {
      setProviderIdentityStatus(false);
      logWarn("Provider identity verification failed", errorExtra(error));
      return false;
    }
  };
  if (!(await refresh())) {
    throw new Error("Provider wallet does not match its ERC-8004 agent wallet");
  }
  const interval = Math.max(
    15_000,
    Math.floor(config.READINESS_MAX_AGE_SECONDS * 500),
  );
  const timer = setInterval(() => void refresh(), interval);
  timer.unref();
  return () => clearInterval(timer);
}

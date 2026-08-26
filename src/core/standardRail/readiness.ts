import type { Chain } from "viem";
import { CHAIN_MODE_MOCK } from "../chain/client.js";
import { setRailStatus } from "../health.js";
import { logWarn } from "../logger.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { ProviderEvidenceVerifier } from "./evidence.js";

export async function startStandardRailReadiness(
  config: ProviderStandardRailConfig,
  chain: Chain,
): Promise<() => void> {
  if (CHAIN_MODE_MOCK) {
    setRailStatus(true);
    return () => undefined;
  }
  const verifier = new ProviderEvidenceVerifier(config, chain);
  await verifier.verifyReadiness();
  setRailStatus(true);
  let inFlight = false;
  const refresh = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await verifier.verifyLiveReadiness();
      setRailStatus(true);
    } catch {
      setRailStatus(false);
      logWarn("Standard-rail readiness verification failed");
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void refresh(), 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

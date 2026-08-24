import type { Chain } from "viem";
import { failWorker, heartbeatWorker, setWorkerStatus } from "../health.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { ProviderEvidenceVerifier } from "./evidence.js";

const WORKER = "standard-rail-evidence";

export async function startStandardRailReadiness(
  config: ProviderStandardRailConfig,
  chain: Chain,
): Promise<() => void> {
  const verifier = new ProviderEvidenceVerifier(config, chain);
  let verificationInFlight = false;
  const verifyEvidence = async () => {
    if (verificationInFlight) return;
    verificationInFlight = true;
    try {
      await verifier.verifyLiveReadiness();
      heartbeatWorker(WORKER, 90);
    } catch {
      failWorker(WORKER);
    } finally {
      verificationInFlight = false;
    }
  };
  setWorkerStatus(WORKER, false, 90);
  await verifier.verifyReadiness();
  heartbeatWorker(WORKER, 90);
  const timer = setInterval(() => void verifyEvidence(), 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

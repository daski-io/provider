import { failWorker, heartbeatWorker, setWorkerStatus } from "../health.js";
import { errorExtra, logError, logInfo, logWarn } from "../logger.js";
import { withCycleLease } from "../db/cycleLease.js";
import { CHAIN_MODE_MOCK } from "./client.js";
import { reconcileProviderNonceGap } from "./providerWriteCoordinator.js";

const WORKER = "provider-write-reconciler";
const INTERVAL_MS = 30_000;
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

export async function runProviderWriteReconciliation(): Promise<void> {
  const result = await withCycleLease("daski:provider-write-reconcile:v1", async () =>
    reconcileProviderNonceGap());
  if (result === null) return;
  if (result === "clear") {
    heartbeatWorker(WORKER);
    return;
  }
  failWorker(WORKER);
  logWarn("Provider wallet nonce gap recovery is active", { result });
}

export function startProviderWriteReconciler(): void {
  if (timer) return;
  if (CHAIN_MODE_MOCK) {
    // There is no wallet nonce to reconcile in mock mode, and the mock
    // transport deliberately points at a blackhole, so every cycle would
    // throw. requiredWorkerNames() drops this worker in mock mode to match.
    logInfo("Provider write reconciler skipped (CHAIN_MODE=mock)");
    return;
  }
  setWorkerStatus(WORKER, false);
  const run = () => {
    if (inFlight) return;
    inFlight = runProviderWriteReconciliation();
    void inFlight.catch((error) => {
      failWorker(WORKER);
      logError("Provider wallet write reconciliation failed", errorExtra(error));
    }).finally(() => {
      inFlight = null;
    });
  };
  run();
  timer = setInterval(run, INTERVAL_MS);
  timer.unref();
}

export async function stopProviderWriteReconciler(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  if (inFlight) await inFlight.catch(() => undefined);
}

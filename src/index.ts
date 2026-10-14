import { base, baseSepolia } from "viem/chains";
import { startProviderIdentityMonitor } from "./core/chain/providerIdentity.js";
import { verifyRuntimeChainTrust } from "./core/chain/runtimeTrust.js";
import { config } from "./core/config.js";
import { closeMigrationPool, migrationPool, pool } from "./core/db/pool.js";
import { prepareProviderDatabase } from "./core/db/startup.js";
import { externalJobKeyRing } from "./core/externalJobs/keyRing.js";
import { declaredExternalJobAdapters, externalJobServicing } from "./core/externalJobs/servicing.js";
import { workerSettingsFromConfig } from "./core/externalJobs/settings.js";
import { ExternalJobWorker } from "./core/externalJobs/worker.js";
import { BUILD_CAPABILITIES, registerRuntimeInstance, RUNTIME_INSTANCE_ID } from "./core/runtimeInstance.js";
import { errorExtra, logError, logInfo, logWarn } from "./core/logger.js";
import { stopSalesOnCommitmentDrift } from "./core/gatewayRegistration/commitmentDriftBoot.js";
import { startServer, stopServer } from "./core/server.js";
import { registerService } from "./core/serviceRegistry/registry.js";
import {
  loadProviderStandardRailConfig,
  type ProviderStandardRailConfig,
} from "./core/standardRail/config.js";
import { assertCatalogComposition } from "./core/standardRail/catalogComposition.js";
import { deriveProviderLaunchPolicy } from "./core/standardRail/launchPolicy.js";
import { DEFAULT_FULFILLMENT_SECONDS } from "./core/standardRail/catalogOutcomes.js";
import { countLegacyExecutions } from "./core/standardRail/legacyCutover.js";
import { pruneSettledQuotes } from "./core/standardRail/quoteStore.js";
import { startStandardRailReadiness } from "./core/standardRail/readiness.js";
import { ResultContracts } from "./core/standardRail/resultContracts.js";
import { verifyRetainedObligations } from "./core/standardRail/retainedObligations.js";
import { startSyncLeaseSweeper } from "./core/standardRail/syncLease.js";
import { configuredServices } from "./providerServices.js";

let shuttingDown = false;
let stopIdentity: (() => void) | null = null;
let stopRail: (() => void) | null = null;
let stopLeases: (() => void) | null = null;
let stopInstance: (() => Promise<void>) | null = null;
let worker: ExternalJobWorker | null = null;

async function main(): Promise<void> {
  logInfo("Starting Daski minimal provider", {
    chainId: config.CHAIN_ID,
    chainMode: config.CHAIN_MODE,
  });
  await prepareProviderDatabase();

  const services = configuredServices(config.CHAIN_ID);
  for (const service of services) registerService(service);
  const standard = await loadProviderStandardRailConfig(
    deriveProviderLaunchPolicy(services),
    process.env,
    { warn: (message) => logWarn(message) },
  );
  assertCatalogComposition(standard);
  const jobKeys = externalJobKeyRing(config, standard.retainedSigningKeys.values());
  // An incompatible build cannot take over: every claim's listing version
  // needs its signing key, every version whose quotes may still be
  // dispatched needs its admitted definition and handler, and every
  // unfinished external job needs its definition, its adapter version and
  // the keys its stored state names.
  await verifyRetainedObligations(pool, standard, externalJobServicing(services, jobKeys));
  await pruneQuotes(standard);
  await closeMigrationPool();
  await stopSalesOnCommitmentDrift({
    gatewayOrigin: standard.gatewayOrigin,
    baseUrl: config.BASE_URL,
    services,
  });

  stopInstance = await registerRuntimeInstance(pool, config.DEPLOYMENT_REVISION ?? "unknown", {
    ...BUILD_CAPABILITIES,
    externalJobAdapters: declaredExternalJobAdapters(services),
  });
  // Only executions whose lease expired are failed; another process's live
  // call is never swept. Pre-R1 rows wait for the operator's cutover.
  stopLeases = await startSyncLeaseSweeper();
  const legacy = await countLegacyExecutions(pool);
  if (legacy > 0) {
    logWarn("Pre-R1 executions await the stop-and-drain cutover", {
      count: legacy,
      remedy: "npm run daski:cutover",
    });
  }

  await verifyRuntimeChainTrust();
  stopIdentity = await startProviderIdentityMonitor();
  stopRail = await startStandardRailReadiness(
    standard,
    config.CHAIN_ID === 8453 ? base : baseSepolia,
  );
  // External jobs are found again from the database: due and abandoned
  // work resumes in its persisted phase, nothing is resubmitted.
  worker = new ExternalJobWorker({
    owner: RUNTIME_INSTANCE_ID,
    settings: workerSettingsFromConfig(config),
    keys: jobKeys,
    resultContracts: new ResultContracts(standard),
  });
  worker.start();
  await startServer(standard, worker.runtime(config.PROVIDER_AGENT_ID.toString()));

  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 0));
}

/**
 * Housekeeping as the schema owner: drop quotes that can no longer back a
 * dispatch (quoteStore.ts). Best effort; a failure never blocks servicing.
 */
async function pruneQuotes(standard: ProviderStandardRailConfig): Promise<void> {
  const longest = Math.max(
    DEFAULT_FULFILLMENT_SECONDS,
    ...[...standard.servicing.values()].map((outcome) => outcome.fulfillmentSeconds),
  );
  try {
    const pruned = await pruneSettledQuotes(migrationPool, longest);
    if (pruned > 0) logInfo("Pruned settled provider quotes", { count: pruned });
  } catch (error) {
    logError("Settled provider quotes could not be pruned", errorExtra(error));
  }
}

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo(`Shutting down after ${reason}`);
  try {
    await stopServer();
    await worker?.stop();
    stopIdentity?.();
    stopRail?.();
    stopLeases?.();
    await stopInstance?.();
    await closeMigrationPool();
    await pool.end();
  } catch (error) {
    exitCode = 1;
    logError("Shutdown failed", errorExtra(error));
  } finally {
    process.exit(exitCode);
  }
}

process.on("unhandledRejection", (reason) => {
  logError("Fatal unhandled promise rejection", errorExtra(reason));
  void shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (error) => {
  logError("Fatal uncaught exception", errorExtra(error));
  void shutdown("uncaughtException", 1);
});

main().catch((error) => {
  const cause = error instanceof Error ? error.message : String(error);
  logError(`Startup failed: ${cause}`, errorExtra(error));
  void shutdown("startup failure", 1);
});

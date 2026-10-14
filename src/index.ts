import { base, baseSepolia } from "viem/chains";
import { startProviderIdentityMonitor } from "./core/chain/providerIdentity.js";
import { verifyRuntimeChainTrust } from "./core/chain/runtimeTrust.js";
import { config } from "./core/config.js";
import { closeMigrationPool, pool } from "./core/db/pool.js";
import { prepareProviderDatabase } from "./core/db/startup.js";
import { errorExtra, logError, logInfo, logWarn } from "./core/logger.js";
import { stopSalesOnCommitmentDrift } from "./core/gatewayRegistration/commitmentDriftBoot.js";
import { startServer, stopServer } from "./core/server.js";
import {
  getAllServices,
  getSkill,
  registerService,
} from "./core/serviceRegistry/registry.js";
import {
  loadProviderStandardRailConfig,
  type ProviderStandardRailConfig,
} from "./core/standardRail/config.js";
import { deriveProviderLaunchPolicy } from "./core/standardRail/launchPolicy.js";
import { countLegacyExecutions } from "./core/standardRail/legacyCutover.js";
import { startStandardRailReadiness } from "./core/standardRail/readiness.js";
import { verifyRetainedObligations } from "./core/standardRail/retainedObligations.js";
import { startSyncLeaseSweeper } from "./core/standardRail/syncLease.js";
import { configuredServices } from "./providerServices.js";

let shuttingDown = false;
let stopIdentity: (() => void) | null = null;
let stopRail: (() => void) | null = null;
let stopLeases: (() => void) | null = null;

async function main(): Promise<void> {
  logInfo("Starting Daski minimal provider", {
    chainId: config.CHAIN_ID,
    chainMode: config.CHAIN_MODE,
  });
  await prepareProviderDatabase();
  await closeMigrationPool();

  const services = configuredServices(config.CHAIN_ID);
  for (const service of services) registerService(service);
  const standard = await loadProviderStandardRailConfig(
    deriveProviderLaunchPolicy(services),
    process.env,
    { warn: (message) => logWarn(message) },
  );
  validateComposition(standard);
  // An incompatible build cannot take over: every claim's listing version
  // needs its signing key, and every version whose quotes may still be
  // dispatched needs its admitted definition and handler.
  await verifyRetainedObligations(pool, standard);
  await stopSalesOnCommitmentDrift({
    gatewayOrigin: standard.gatewayOrigin,
    baseUrl: config.BASE_URL,
    services,
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
  await startServer(standard);

  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 0));
}

function validateComposition(
  standard: ProviderStandardRailConfig,
): void {
  const configured = new Set<string>();
  for (const outcome of standard.outcomes.values()) {
    const skill = getSkill(outcome.serviceSlug, outcome.skillId);
    if (!skill) {
      throw new Error(`Outcome ${outcome.outcomeId} references an unknown service skill`);
    }
    if (skill.fixedPriceAtomic !== outcome.fixedGrossAmount) {
      throw new Error(`Outcome ${outcome.outcomeId} price differs from its service manifest`);
    }
    configured.add(`${outcome.serviceSlug}/${outcome.skillId}`);
  }
  const installedPaid = new Set(getAllServices().flatMap((service) =>
    service.skills
      .filter((skill) => BigInt(skill.fixedPriceAtomic) > 0n)
      .map((skill) => `${service.manifest.slug}/${skill.id}`)));
  if ([...configured].some((key) => !installedPaid.has(key))) {
    throw new Error("Runtime catalog contains an uninstalled paid skill");
  }
}

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo(`Shutting down after ${reason}`);
  try {
    await stopServer();
    stopIdentity?.();
    stopRail?.();
    stopLeases?.();
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

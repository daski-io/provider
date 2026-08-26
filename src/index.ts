import { base, baseSepolia } from "viem/chains";
import { startProviderIdentityMonitor } from "./core/chain/providerIdentity.js";
import { verifyRuntimeChainTrust } from "./core/chain/runtimeTrust.js";
import { config } from "./core/config.js";
import {
  checkDatabase,
  closeMigrationPool,
  configureRuntimePrivileges,
  failInterruptedTransactions,
  pool,
  runMigrations,
  verifyDatabaseRoleSeparation,
} from "./core/db/pool.js";
import { errorExtra, logError, logInfo, logWarn } from "./core/logger.js";
import { startServer, stopServer } from "./core/server.js";
import {
  getAllServices,
  getSkill,
  registerService,
} from "./core/serviceRegistry/registry.js";
import { loadProviderStandardRailConfig } from "./core/standardRail/config.js";
import { startStandardRailReadiness } from "./core/standardRail/readiness.js";
import { providerLaunchPolicy } from "./providerLaunchPolicy.js";
import { configuredServices } from "./providerServices.js";

let shuttingDown = false;
let stopIdentity: (() => void) | null = null;
let stopRail: (() => void) | null = null;

async function main(): Promise<void> {
  logInfo("Starting Daski minimal provider", {
    chainId: config.CHAIN_ID,
    chainMode: config.CHAIN_MODE,
  });
  if (!(await checkDatabase())) throw new Error("Database unreachable");
  await runMigrations();
  await configureRuntimePrivileges();
  await verifyDatabaseRoleSeparation();
  await closeMigrationPool();

  for (const service of configuredServices(config.CHAIN_ID)) registerService(service);
  const standard = loadProviderStandardRailConfig(providerLaunchPolicy);
  validateComposition(standard);

  const interrupted = await failInterruptedTransactions();
  if (interrupted > 0) {
    logWarn("Marked interrupted synchronous executions as failed", { count: interrupted });
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
  standard: ReturnType<typeof loadProviderStandardRailConfig>,
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
  const installed = getAllServices().flatMap((service) =>
    service.skills.map((skill) => `${service.manifest.slug}/${skill.id}`));
  if (configured.size !== installed.length
    || installed.some((key) => !configured.has(key))) {
    throw new Error("Every installed skill must have exactly one reviewed outcome");
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
  logError("Startup failed", errorExtra(error));
  void shutdown("startup failure", 1);
});

import { pathToFileURL } from "node:url";
import { config } from "./core/config.js";
import { closeMigrationPool, migrationPool, pool } from "./core/db/pool.js";
import { externalJobKeyRing } from "./core/externalJobs/keyRing.js";
import { redactSensitiveText } from "./core/security/redaction.js";
import { registerService } from "./core/serviceRegistry/registry.js";
import { readAsyncAdmission } from "./core/standardRail/asyncAdmission.js";
import {
  activateAsyncAdmission,
  asyncActivationChecks,
  deactivateAsyncAdmission,
  type ActivationCheck,
} from "./core/standardRail/asyncAdmissionActivation.js";
import { loadProviderStandardRailConfig } from "./core/standardRail/config.js";
import { deriveProviderLaunchPolicy } from "./core/standardRail/launchPolicy.js";
import { configuredServices } from "./providerServices.js";

/**
 * The only way async admission is turned on (docs/configuration.md). Without
 * flags it reports the switch and its prerequisite checks read-only;
 * `--activate` enables it only if every check passes in the same
 * transaction; `--deactivate` turns it off. It never migrates: the database
 * must already be at this build's schema epoch.
 */
async function main(): Promise<void> {
  const activate = process.argv.includes("--activate");
  const deactivate = process.argv.includes("--deactivate");
  if (activate && deactivate) throw new Error("choose --activate or --deactivate");
  const services = configuredServices(config.CHAIN_ID);
  for (const service of services) registerService(service);
  const standard = await loadProviderStandardRailConfig(
    deriveProviderLaunchPolicy(services),
    process.env,
  );
  const keys = externalJobKeyRing(config, standard.retainedSigningKeys.values());
  let checks: ActivationCheck[] | null = null;
  if (activate) {
    checks = (await activateAsyncAdmission(() => migrationPool.connect(), standard, keys)).checks;
  } else if (deactivate) {
    await deactivateAsyncAdmission(migrationPool);
  } else {
    checks = await asyncActivationChecks(migrationPool, standard, keys);
  }
  const state = await readAsyncAdmission(migrationPool);
  process.stdout.write(`${JSON.stringify({ asyncAdmission: state, ...(checks ? { checks } : {}) })}\n`);
  if (activate && !state.enabled) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    process.stderr.write(`async admission command failed: ${message}\n`);
    process.exitCode = 1;
  }).finally(async () => {
    await closeMigrationPool().catch(() => undefined);
    await pool.end().catch(() => undefined);
  });
}

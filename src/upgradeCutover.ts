import { pathToFileURL } from "node:url";
import { closeMigrationPool, migrationPool, pool } from "./core/db/pool.js";
import { prepareProviderDatabase } from "./core/db/startup.js";
import { redactSensitiveText } from "./core/security/redaction.js";
import { cutoverInventory, resolveLegacyExecutions } from "./core/standardRail/legacyCutover.js";

/**
 * Operator step of the first pre-R1 to R1 upgrade (docs/onboarding.md):
 * apply this build's migrations, which install the legacy-process barrier,
 * then print the inventory of unresolved work as JSON. With
 * `--resolve-legacy --old-processes-stopped` it also fails the interrupted
 * pre-R1 executions; nothing else is ever resolved here.
 */
async function main(): Promise<void> {
  const resolve = process.argv.includes("--resolve-legacy");
  if (resolve && !process.argv.includes("--old-processes-stopped")) {
    throw new Error("--resolve-legacy requires --old-processes-stopped once every pre-R1 process is stopped");
  }
  await prepareProviderDatabase();
  const inventory = await cutoverInventory(migrationPool);
  const resolved = resolve ? await resolveLegacyExecutions(migrationPool) : null;
  process.stdout.write(`${JSON.stringify({
    inventory,
    ...(resolved ? { resolvedLegacyExecutions: resolved } : {}),
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    process.stderr.write(`cutover failed: ${message}\n`);
    process.exitCode = 1;
  }).finally(async () => {
    await closeMigrationPool().catch(() => undefined);
    await pool.end().catch(() => undefined);
  });
}

import { pathToFileURL } from "node:url";
import type { DiagnosticCheck } from "./core/diagnostics/databaseDiagnostics.js";

/** What the doctor's database mode reports: `performed` only when its read-only snapshot ran. */
export interface DatabaseDoctorReport {
  database: "performed" | "unavailable";
  checks: DiagnosticCheck[];
}

const SNAPSHOT_STATEMENT_TIMEOUT_MS = 15_000;

const unavailable = (message: string, remedy: string): DatabaseDoctorReport => ({
  database: "unavailable",
  checks: [{ code: "DATABASE_DIAGNOSTICS", status: "fail", message, remedy }],
});

/** Variable names of a configuration error, never their values. */
const issueNames = (error: Error) =>
  [...new Set([...error.message.matchAll(/^- ([A-Za-z0-9_.]+):/gm)].map((match) => match[1]))].slice(0, 20);

/**
 * The doctor's read-only database mode (`npm run doctor -- --database`):
 * this build's configuration and service composition, judged against the
 * database in one READ ONLY snapshot that is rolled back. It never
 * migrates, imports a bundle, activates async admission or writes a row,
 * and it reports counts and opaque references, never inputs, job
 * references, URLs or key material. Its modules load only after the
 * configuration parses, so an invalid one is reported, not thrown.
 */
export async function runDatabaseDoctor(): Promise<DatabaseDoctorReport> {
  let composed;
  try {
    composed = await compose();
  } catch (error) {
    if (error instanceof Error && error.name === "ConfigurationError") {
      return unavailable(
        `Database diagnostics were not performed: the configuration is invalid (${issueNames(error).join(", ")}).`,
        "Fix the CONFIG_REQUIRED findings and docs/configuration.md first.",
      );
    }
    const { safeMessage } = await import("./core/diagnostics/checks.js");
    return unavailable(
      `Database diagnostics were not performed: this build's configuration or services do not load (${safeMessage(error)}).`,
      "Correct the named setting or src/providerServices.ts; boot refuses the same build.",
    );
  }
  const { withReadOnlySnapshot, databaseErrorCode } = await import("./core/diagnostics/readOnlySession.js");
  const { runDatabaseDiagnostics } = await import("./core/diagnostics/databaseDiagnostics.js");
  try {
    const checks = await withReadOnlySnapshot(composed.session, (db) => runDatabaseDiagnostics(db, composed.input));
    return {
      database: "performed",
      checks: [{
        code: "DATABASE_DIAGNOSTICS",
        status: "pass",
        message: "Database checks ran in one read-only snapshot, which was rolled back.",
      }, ...checks],
    };
  } catch (error) {
    return unavailable(
      `Database diagnostics were not performed: the database could not be read (${databaseErrorCode(error)}).`,
      "Check DATABASE_URL reachability, credentials and TLS (docs/troubleshooting.md).",
    );
  }
}

async function compose() {
  const { config } = await import("./core/config.js");
  const [
    { configuredServices },
    { registerService },
    { externalJobKeyRing },
    { externalJobServicing },
    { workerSettingsFromConfig },
    { buildMigrations },
    { databaseTlsConfig },
    { loadProviderStandardRailConfig, resolveGatewayIdentity },
    { deriveProviderLaunchPolicy },
    { loadRuntimeListingVersions },
    { parseRetainedSigningKeys },
  ] = await Promise.all([
    import("./providerServices.js"),
    import("./core/serviceRegistry/registry.js"),
    import("./core/externalJobs/keyRing.js"),
    import("./core/externalJobs/servicing.js"),
    import("./core/externalJobs/settings.js"),
    import("./core/db/migrationFiles.js"),
    import("./core/db/tls.js"),
    import("./core/standardRail/config.js"),
    import("./core/standardRail/launchPolicy.js"),
    import("./core/gatewayRegistration/runtimeCatalog.js"),
    import("./core/standardRail/retainedConfig.js"),
  ]);
  const services = configuredServices(config.CHAIN_ID);
  for (const service of services) registerService(service);
  const gateway = resolveGatewayIdentity(process.env);
  const launchPolicy = deriveProviderLaunchPolicy(services);
  return {
    session: {
      connectionString: config.DATABASE_URL,
      ssl: databaseTlsConfig(config.DATABASE_SSL_MODE, config.DATABASE_CA_CERT),
      statementTimeoutMs: Math.min(config.DATABASE_STATEMENT_TIMEOUT_MS, SNAPSHOT_STATEMENT_TIMEOUT_MS),
      connectTimeoutMs: config.DATABASE_ACQUIRE_TIMEOUT_MS,
    },
    input: {
      migrations: buildMigrations(),
      // The key ring exactly as boot builds it: no encryption key may equal a
      // signing key, current or retained.
      servicing: externalJobServicing(services, externalJobKeyRing(
        config,
        parseRetainedSigningKeys(process.env, config.PROVIDER_WALLET_PRIVATE_KEY as `0x${string}`).values(),
      )),
      externalJobServices: services
        .filter((service) => service.adapter.mode === "external-job")
        .map((service) => service.manifest.slug),
      paidSkills: launchPolicy.paidSkills,
      leaseSeconds: workerSettingsFromConfig(config).leaseSeconds,
      gatewayAudience: gateway.gatewayAudience,
      standardRail: async (db: Parameters<typeof loadRuntimeListingVersions>[1]) =>
        loadProviderStandardRailConfig(launchPolicy, process.env, {
          versionsOverride: await loadRuntimeListingVersions(gateway.gatewayOrigin, db),
        }),
    },
  };
}

// Run by scripts/doctor.mjs as a forked child (the report goes back over the
// IPC channel) or directly, e.g. `node dist/doctorDatabase.js` inside the
// image, which prints it as JSON.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runDatabaseDoctor();
  const failed = report.checks.some((item) => item.status === "fail");
  if (process.send) {
    process.send(report, () => process.exit(0));
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = failed ? 1 : 0;
  }
}

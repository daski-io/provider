import { fork } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const stages = new Set(["local", "testnet", "mainnet"]);
const statuses = new Set(["pass", "warn", "fail", "skip"]);
const DATABASE_TIMEOUT_MS = 60_000;

function parseArgs(args) {
  const options = { stage: "local", json: false, help: false, database: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--database") options.database = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--stage") options.stage = args[++index];
    else if (arg.startsWith("--stage=")) options.stage = arg.slice(8);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!stages.has(options.stage)) {
    throw new Error("--stage must be local, testnet, or mainnet");
  }
  return options;
}

function check(code, status, message, remedy) {
  return { code, status, message, ...(remedy ? { remedy } : {}) };
}

function missing(names) {
  return names.filter((name) => {
    const value = process.env[name]?.trim() ?? "";
    return !value || /REPLACE_|example\.invalid/i.test(value);
  });
}

function diagnostics(stage) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(check(
    "NODE_VERSION",
    nodeMajor === 24 ? "pass" : "fail",
    nodeMajor === 24 ? "Node 24 is active." : `Node ${process.versions.node} is unsupported.`,
    "Install the Node version declared in package.json.",
  ));
  checks.push(check(
    "ENV_FILE",
    existsSync(".env") ? "pass" : "fail",
    existsSync(".env") ? ".env is present." : ".env is missing.",
    "Copy .env.example to .env and replace every placeholder.",
  ));
  const common = missing([
    "BASE_URL", "GATEWAY_BASE_URL", "PROVIDER_NAME",
    "MARKETPLACE_TERMS_URL", "MARKETPLACE_PRIVACY_URL",
    "PROVIDER_TERMS_URL", "PROVIDER_PRIVACY_URL", "SUPPORT_EMAIL",
    "DATABASE_URL", "CHAIN_ID", "BASE_RPC_URL", "PROVIDER_WALLET_PRIVATE_KEY",
    "PROVIDER_AGENT_ID", "IDENTITY_REGISTRY_ADDRESS", "USDC_ADDRESS",
    "RATE_LIMIT_HASH_KEY",
  ]);
  checks.push(check(
    "CONFIG_REQUIRED",
    common.length === 0 ? "pass" : "fail",
    common.length === 0
      ? "Required provider variables are present."
      : `Missing or placeholder variables: ${common.join(", ")}.`,
    "Use docs/configuration.md; do not invent Daski-issued values.",
  ));
  if (stage !== "local") {
    const rail = missing([
      "STANDARD_RAIL_GATEWAY_SIGNER", "STANDARD_RAIL_GATEWAY_AUDIENCE",
      "STANDARD_RAIL_GATEWAY_ORIGIN", "STANDARD_RAIL_PROVIDER_AUDIENCE",
      "REPUTATION_STORAGE_ADDRESS",
      "EAS_ADDRESS", "EAS_RUNTIME_CODE_HASH", "EAS_OUTCOME_SCHEMA_UID",
      "SANCTIONS_ORACLE_ADDRESS", "STANDARD_RAIL_GLOBAL_POLICY_JSON",
      "STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH",
    ]);
    checks.push(check(
      "STANDARD_RAIL_ARTIFACTS",
      rail.length === 0 ? "pass" : "fail",
      rail.length === 0
        ? "Standard-rail bindings are present."
        : `Missing Daski-issued bindings: ${rail.join(", ")}.`,
      "Complete Testnet onboarding and copy the reviewed values exactly.",
    ));
    checks.push(check(
      "RUNTIME_BUNDLE_REQUIRED",
      "warn",
      "Doctor never installs a runtime bundle; only --database reads the catalog (RUNTIME_CATALOG).",
      "Install the Daski-issued bundle with npm run daski:install-runtime -- --file <path>.",
    ));
  }
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  checks.push(check(
    "DEPENDENCIES_INSTALLED",
    existsSync("node_modules") ? "pass" : "fail",
    existsSync("node_modules") ? "Dependencies are installed." : "node_modules is absent.",
    `Run npm ci with Node ${packageJson.engines.node}.`,
  ));
  if (stage === "mainnet") {
    const machineReady =
      process.env.NODE_ENV === "production"
      && process.env.CHAIN_ID === "8453"
      && process.env.DATABASE_SSL_MODE === "verify-full"
      && Boolean(process.env.MIGRATION_DATABASE_URL)
      && process.env.EDGE_RATE_LIMIT_VERIFIED?.toLowerCase() === "true";
    checks.push(check(
      "MAINNET_RUNTIME",
      machineReady ? "pass" : "fail",
      machineReady
        ? "Machine-checkable Mainnet runtime settings are present."
        : "Mainnet production, chain, database, proxy, or edge settings are incomplete.",
      "Complete docs/onboarding.md and docs/configuration.md.",
    ));
    checks.push(check(
      "DUMMY_SERVICE_REMOVED",
      existsSync("src/services/dummy") ? "fail" : "pass",
      existsSync("src/services/dummy")
        ? "The Testnet-only dummy service is still installed."
        : "The dummy service is absent.",
      "Replace dummy with the reviewed product service before Mainnet.",
    ));
    const composition = existsSync("src/providerServices.ts")
      ? readFileSync("src/providerServices.ts", "utf8")
      : "";
    const syntheticComposed = /services\/synthetic-audit/.test(composition);
    checks.push(check(
      "SYNTHETIC_EXAMPLE_NOT_COMPOSED",
      syntheticComposed ? "fail" : "pass",
      syntheticComposed
        ? "The Testnet-only synthetic audit example is composed in src/providerServices.ts."
        : "The synthetic audit example is not composed.",
      "Compose your own external-job service; the example has a fake product and refuses Base Mainnet.",
    ));
    checks.push(check(
      "MAINNET_WHITELIST_REQUIRED",
      "warn",
      "Mainnet whitelisting cannot be proven by this repository.",
      "Request Mainnet access in the Daski Discord after successful Testnet review.",
    ));
  }
  return checks;
}

/**
 * The read-only database mode runs src/doctorDatabase.ts in a child process
 * (TypeScript through tsx, reusing this build's own checks) and receives its
 * report over IPC; the child's own output is discarded, so nothing it
 * prints can reach this report.
 */
function databaseDiagnostics() {
  const unavailable = (message, remedy) => ({
    database: "unavailable",
    checks: [check("DATABASE_DIAGNOSTICS", "fail", message, remedy)],
  });
  let loader;
  try {
    loader = import.meta.resolve("tsx");
  } catch {
    return Promise.resolve(unavailable(
      "Database diagnostics were not performed: tsx is not installed.",
      "Run npm ci in this checkout.",
    ));
  }
  const entry = fileURLToPath(new URL("../src/doctorDatabase.ts", import.meta.url));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (report) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(report);
    };
    const child = fork(entry, [], {
      execArgv: ["--import", loader],
      env: process.env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(unavailable(
        `Database diagnostics were not performed: no report within ${DATABASE_TIMEOUT_MS / 1_000} seconds.`,
        "Check DATABASE_URL reachability and DATABASE_STATEMENT_TIMEOUT_MS.",
      ));
    }, DATABASE_TIMEOUT_MS);
    child.once("message", (message) => finish(validDatabaseReport(message) ? message : unavailable(
      "Database diagnostics returned an unreadable report.",
      "Run npm ci, then retry.",
    )));
    child.once("error", () => finish(unavailable(
      "Database diagnostics were not performed: the diagnostic process could not start.",
      "Run npm ci with Node 24, then retry.",
    )));
    child.once("close", () => finish(unavailable(
      "Database diagnostics were not performed: the diagnostic process stopped before reporting.",
      "Run npm run typecheck; a build that does not load cannot be diagnosed.",
    )));
  });
}

function validDatabaseReport(report) {
  return Boolean(report) && typeof report === "object"
    && (report.database === "performed" || report.database === "unavailable")
    && Array.isArray(report.checks) && report.checks.length > 0
    && report.checks.every((item) => item && typeof item.code === "string"
      && /^[A-Z][A-Z0-9_]{2,63}$/.test(item.code) && statuses.has(item.status)
      && typeof item.message === "string");
}

function human(stage, checks) {
  const lines = [`Daski provider doctor (${stage})`, ""];
  for (const item of checks) {
    lines.push(`[${item.status.toUpperCase()}] ${item.code}: ${item.message}`);
    if (item.remedy && item.status !== "pass") lines.push(`  ${item.remedy}`);
  }
  const failed = checks.filter((item) => item.status === "fail").length;
  lines.push("", failed === 0
    ? "Result: ready for the next documented step."
    : `Result: ${failed} blocking check(s).`);
  return `${lines.join("\n")}\n`;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: npm run doctor -- [--stage local|testnet|mainnet] [--database] [--json]\n"
      + "  --database  also run read-only database diagnostics with DATABASE_URL\n",
    );
  } else {
    const checks = diagnostics(options.stage);
    let database = "not_performed";
    if (options.database) {
      const result = await databaseDiagnostics();
      database = result.database;
      checks.push(...result.checks);
    } else {
      checks.push(check(
        "DATABASE_DIAGNOSTICS",
        "skip",
        "Database checks were not performed: the doctor ran offline.",
        "Add --database for read-only database diagnostics with DATABASE_URL.",
      ));
    }
    const report = {
      schemaVersion: 2,
      stage: options.stage,
      database,
      ok: checks.every((item) => item.status !== "fail"),
      checks,
    };
    process.stdout.write(options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : human(options.stage, checks));
    if (!report.ok) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(
    `Daski provider doctor: ${error instanceof Error ? error.message : "failed"}\n`,
  );
  process.exitCode = 2;
}

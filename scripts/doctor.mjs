import { existsSync, readFileSync } from "node:fs";

const stages = new Set(["local", "testnet", "mainnet"]);

function parseArgs(args) {
  const options = { stage: "local", json: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
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
      "STANDARD_RAIL_PROVIDER_AUDIENCE", "REPUTATION_STORAGE_ADDRESS",
      "EAS_ADDRESS", "EAS_RUNTIME_CODE_HASH", "EAS_OUTCOME_SCHEMA_UID",
      "SANCTIONS_ORACLE_ADDRESS", "STANDARD_RAIL_OUTCOMES_JSON",
    ]);
    checks.push(check(
      "STANDARD_RAIL_ARTIFACTS",
      rail.length === 0 ? "pass" : "fail",
      rail.length === 0
        ? "Standard-rail bindings are present."
        : `Missing Daski-issued bindings: ${rail.join(", ")}.`,
      "Complete Testnet onboarding and copy the reviewed values exactly.",
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
    checks.push(check(
      "MAINNET_WHITELIST_REQUIRED",
      "warn",
      "Mainnet whitelisting cannot be proven by this repository.",
      "Request Mainnet access in the Daski Discord after successful Testnet review.",
    ));
  }
  return checks;
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
      "Usage: npm run doctor -- [--stage local|testnet|mainnet] [--json]\n",
    );
  } else {
    const checks = diagnostics(options.stage);
    const report = {
      schemaVersion: 1,
      stage: options.stage,
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

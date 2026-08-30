import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const secret = "doctor-secret-that-must-never-be-printed";
const environment = {
  ...process.env,
  BASE_URL: "https://provider.example.invalid",
  GATEWAY_BASE_URL: "https://gateway.example.invalid",
  PROVIDER_NAME: "Doctor Test Provider",
  MARKETPLACE_TERMS_URL: "https://market.example.invalid/terms",
  MARKETPLACE_PRIVACY_URL: "https://market.example.invalid/privacy",
  PROVIDER_TERMS_URL: "https://provider.example.invalid/terms",
  PROVIDER_PRIVACY_URL: "https://provider.example.invalid/privacy",
  SUPPORT_EMAIL: "support@example.invalid",
  DATABASE_URL: "postgresql://doctor:password@127.0.0.1:5432/doctor",
  CHAIN_ID: "84532",
  BASE_RPC_URL: "https://rpc.example.invalid",
  PROVIDER_WALLET_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  PROVIDER_AGENT_ID: "1",
  IDENTITY_REGISTRY_ADDRESS: `0x${"22".repeat(20)}`,
  USDC_ADDRESS: `0x${"33".repeat(20)}`,
  RATE_LIMIT_HASH_KEY: secret,
  STANDARD_RAIL_GATEWAY_SIGNER: `0x${"44".repeat(20)}`,
  STANDARD_RAIL_GATEWAY_ORIGIN: "https://gateway.example.invalid",
  STANDARD_RAIL_GATEWAY_AUDIENCE: "https://gateway.example.invalid",
  STANDARD_RAIL_PROVIDER_AUDIENCE: "https://provider.example.invalid",
  REPUTATION_STORAGE_ADDRESS: `0x${"55".repeat(20)}`,
  EAS_ADDRESS: `0x${"66".repeat(20)}`,
  EAS_RUNTIME_CODE_HASH: `0x${"77".repeat(32)}`,
  EAS_OUTCOME_SCHEMA_UID: `0x${"88".repeat(32)}`,
  SANCTIONS_ORACLE_ADDRESS: `0x${"99".repeat(20)}`,
  STANDARD_RAIL_GLOBAL_POLICY_JSON: "present-for-doctor",
  STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH: `0x${"aa".repeat(32)}`,
};

describe("doctor", () => {
  it("emits parseable redacted diagnostics through the Node executable", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/doctor.mjs", "--stage=testnet", "--json"],
      { cwd: process.cwd(), env: environment, encoding: "utf8" },
    );
    expect([0, 1]).toContain(result.status);
    const report = JSON.parse(result.stdout) as {
      schemaVersion: number;
      stage: string;
      checks: Array<{ code: string }>;
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.stage).toBe("testnet");
    expect(report.checks.map((item) => item.code)).toEqual(expect.arrayContaining([
      "NODE_VERSION",
      "ENV_FILE",
      "CONFIG_REQUIRED",
      "STANDARD_RAIL_ARTIFACTS",
      "DEPENDENCIES_INSTALLED",
    ]));
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it("rejects an unknown stage with usage-error status", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/doctor.mjs", "--stage=production"],
      { cwd: process.cwd(), env: environment, encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--stage must be local, testnet, or mainnet");
    expect(result.stderr).not.toContain(secret);
  });
});

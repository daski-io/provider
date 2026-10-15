import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const secret = "doctor-secret-that-must-never-be-printed";
const password = "doctor-database-password-never-printed";
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  BASE_URL: "https://provider.example.invalid",
  GATEWAY_BASE_URL: "https://gateway.example.invalid",
  PROVIDER_NAME: "Doctor Test Provider",
  MARKETPLACE_TERMS_URL: "https://market.example.invalid/terms",
  MARKETPLACE_PRIVACY_URL: "https://market.example.invalid/privacy",
  PROVIDER_TERMS_URL: "https://provider.example.invalid/terms",
  PROVIDER_PRIVACY_URL: "https://provider.example.invalid/privacy",
  SUPPORT_EMAIL: "support@example.invalid",
  // Nothing listens on port 1: the database cannot be reached.
  DATABASE_URL: `postgresql://doctor:${password}@127.0.0.1:1/doctor`,
  DATABASE_ACQUIRE_TIMEOUT_MS: "2000",
  CHAIN_ID: "84532",
  BASE_RPC_URL: "https://rpc.example.invalid",
  PROVIDER_WALLET_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  PROVIDER_AGENT_ID: "1",
  IDENTITY_REGISTRY_ADDRESS: `0x${"22".repeat(20)}`,
  USDC_ADDRESS: `0x${"33".repeat(20)}`,
  RATE_LIMIT_HASH_KEY: secret,
};

function doctor(env: NodeJS.ProcessEnv) {
  const result = spawnSync(
    process.execPath,
    ["scripts/doctor.mjs", "--stage=local", "--database", "--json"],
    { cwd: process.cwd(), env, encoding: "utf8", timeout: 90_000 },
  );
  const report = JSON.parse(result.stdout) as {
    database: string;
    checks: Array<{ code: string; status: string; message: string }>;
  };
  return { result, report, diagnostics: report.checks.find((item) => item.code === "DATABASE_DIAGNOSTICS") };
}

// L-T20: a requested database check that cannot run is a failure that says
// it was not performed, never a pass, and it names no value.
describe("doctor database mode without a usable database", () => {
  it("reports an unreachable database by its network code only", () => {
    const { result, report, diagnostics } = doctor(environment);
    expect(result.status).toBe(1);
    expect(report.database).toBe("unavailable");
    expect(diagnostics).toMatchObject({ status: "fail" });
    expect(diagnostics?.message).toContain("not performed");
    // Refused on most hosts; a host that drops the packet times out instead.
    expect(diagnostics?.message).toMatch(/could not be read \((?:ECONNREFUSED|ETIMEDOUT|unknown)\)/);
    expect(report.checks.map((item) => item.code)).not.toContain("DATABASE_SCHEMA_EPOCH");
    for (const value of [password, secret, "127.0.0.1:1"]) {
      expect(`${result.stdout}${result.stderr}`).not.toContain(value);
    }
  });

  it("builds the key ring as boot does, refusing an encryption key that is a retained wallet key", () => {
    const retained = `0x${"5e".repeat(32)}`;
    const { report, diagnostics } = doctor({
      ...environment,
      PROVIDER_RETAINED_WALLET_PRIVATE_KEYS: retained,
      PROVIDER_DATA_ENCRYPTION_KEY: retained,
    });
    expect(report.database).toBe("unavailable");
    expect(diagnostics?.message).toContain("must not reuse a signing key");
    expect(JSON.stringify(report)).not.toContain(retained.slice(2));
  });

  it("names invalid configuration variables, never their values", () => {
    const invalidKey = "0xnot-a-wallet-key-but-still-never-printed";
    const { report, diagnostics } = doctor({ ...environment, PROVIDER_WALLET_PRIVATE_KEY: invalidKey });
    expect(report.database).toBe("unavailable");
    expect(diagnostics?.status).toBe("fail");
    expect(diagnostics?.message).toContain("configuration is invalid (PROVIDER_WALLET_PRIVATE_KEY");
    expect(JSON.stringify(report)).not.toContain(invalidKey);
  });
});

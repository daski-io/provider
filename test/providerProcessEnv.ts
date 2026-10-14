import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { providerKey } from "./gatewayWire.js";
import { buildGlobalPolicyFixture, encodeGlobalPolicy, testGatewaySigner } from "./runtimeCatalogFixture.js";
import type { StandardRailGlobalPolicy } from "../src/core/standardRail/catalogOutcomes.js";

export async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * The complete offline environment of a spawned provider process (server or
 * operator command): loopback mock chain mode, the fixture gateway signer and
 * global policy, and the given database principals.
 */
export async function providerProcessEnv(args: {
  port?: number;
  databaseUrl: string;
  migrationDatabaseUrl?: string;
  globalPolicy?: StandardRailGlobalPolicy;
}): Promise<NodeJS.ProcessEnv> {
  const port = args.port ?? await freePort();
  return {
    PATH: process.env.PATH,
    NODE_ENV: "development",
    PORT: String(port),
    BASE_URL: `http://127.0.0.1:${port}`,
    GATEWAY_BASE_URL: "https://gateway.example",
    CHAIN_MODE: "mock",
    PROVIDER_NAME: "Process Test Provider",
    MARKETPLACE_TERMS_URL: "https://marketplace.test/terms",
    MARKETPLACE_PRIVACY_URL: "https://marketplace.test/privacy",
    PROVIDER_TERMS_URL: "https://provider.test/terms",
    PROVIDER_PRIVACY_URL: "https://provider.test/privacy",
    SUPPORT_EMAIL: "support@provider.test",
    DATABASE_URL: args.databaseUrl,
    ...(args.migrationDatabaseUrl ? { MIGRATION_DATABASE_URL: args.migrationDatabaseUrl } : {}),
    DATABASE_SSL_MODE: "disable",
    CHAIN_ID: "84532",
    BASE_RPC_URL: "https://rpc.example",
    PROVIDER_WALLET_PRIVATE_KEY: providerKey,
    PROVIDER_AGENT_ID: "8327",
    IDENTITY_REGISTRY_ADDRESS: "0x1111111111111111111111111111111111111111",
    USDC_ADDRESS: "0x6666666666666666666666666666666666666666",
    RATE_LIMIT_HASH_KEY: "testing-only-rate-limit-key-with-entropy-1234567890",
    STANDARD_RAIL_ENVIRONMENT: "testnet",
    STANDARD_RAIL_GATEWAY_SIGNER: testGatewaySigner,
    STANDARD_RAIL_GATEWAY_ORIGIN: "https://gateway.example",
    STANDARD_RAIL_GATEWAY_AUDIENCE: "https://gateway.example",
    STANDARD_RAIL_GLOBAL_POLICY_JSON: encodeGlobalPolicy(args.globalPolicy ?? await buildGlobalPolicyFixture()),
    STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH: `0x${"3".repeat(64)}`,
    SANCTIONS_ORACLE_ADDRESS: "0x5555555555555555555555555555555555555555",
    REPUTATION_STORAGE_ADDRESS: "0x4545454545454545454545454545454545454545",
    EAS_ADDRESS: "0x4646464646464646464646464646464646464646",
    EAS_RUNTIME_CODE_HASH: `0x${"f".repeat(64)}`,
    EAS_OUTCOME_SCHEMA_UID: `0x${"e".repeat(64)}`,
  };
}

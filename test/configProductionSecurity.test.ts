import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    BASE_URL: "https://provider.example",
    GATEWAY_BASE_URL: "https://gateway.example",
    CHAIN_MODE: "live",
    PROVIDER_NAME: "Example Provider",
    MARKETPLACE_TERMS_URL: "https://daski.example/terms",
    MARKETPLACE_PRIVACY_URL: "https://daski.example/privacy",
    PROVIDER_TERMS_URL: "https://provider.example/terms",
    PROVIDER_PRIVACY_URL: "https://provider.example/privacy",
    SUPPORT_EMAIL: "support@provider.example",
    DATABASE_URL: "postgresql://runtime:secret@db.example/provider",
    DATABASE_SSL_MODE: "disable",
    CHAIN_ID: "84532",
    BASE_RPC_URL: "https://rpc.example",
    PROVIDER_WALLET_PRIVATE_KEY: `0x${"44".repeat(32)}`,
    PROVIDER_AGENT_ID: "1",
    IDENTITY_REGISTRY_ADDRESS: "0x1111111111111111111111111111111111111111",
    USDC_ADDRESS: "0x6666666666666666666666666666666666666666",
    RATE_LIMIT_HASH_KEY: "a-secure-rate-limit-key-1234567890-ABCDEFG",
  };
}

describe("configuration security", () => {
  it("loads a Testnet-first development environment", () => {
    expect(parseConfig(environment())).toMatchObject({
      CHAIN_ID: 84532,
      DATABASE_POOL_MAX: 10,
      EDGE_RATE_LIMIT_VERIFIED: false,
    });
  });

  it("requires verified TLS and a separate migration principal in production", () => {
    const env: NodeJS.ProcessEnv = { ...environment(), NODE_ENV: "production" };
    expect(() => parseConfig(env)).toThrow(/verify-full/);
    env.DATABASE_SSL_MODE = "verify-full";
    expect(() => parseConfig(env)).toThrow(/MIGRATION_DATABASE_URL/);
    env.MIGRATION_DATABASE_URL = env.DATABASE_URL;
    expect(() => parseConfig(env)).toThrow(/distinct/);
    env.MIGRATION_DATABASE_URL =
      "postgresql://migrator:secret@db.example/provider";
    expect(() => parseConfig(env)).not.toThrow();
  });

  it("rejects mock production, zero wallet keys, and placeholder secrets", () => {
    expect(() => parseConfig({
      ...environment(),
      NODE_ENV: "production",
      CHAIN_MODE: "mock",
      DATABASE_SSL_MODE: "verify-full",
      MIGRATION_DATABASE_URL: "postgresql://migrator:secret@db.example/provider",
    })).toThrow(/mock/);
    expect(() => parseConfig({
      ...environment(),
      PROVIDER_WALLET_PRIVATE_KEY: `0x${"00".repeat(32)}`,
    })).toThrow(/zero key/);
    expect(() => parseConfig({
      ...environment(),
      RATE_LIMIT_HASH_KEY: "replace-with-a-long-random-string",
    })).toThrow(/placeholder/);
  });

  it("rejects the retired payment rail selector", () => {
    expect(() => parseConfig({ ...environment(), PAYMENT_RAIL: "native" }))
      .toThrow(/retired/);
  });
});

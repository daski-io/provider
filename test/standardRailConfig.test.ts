import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { recipeNonce } from "../src/core/standardRail/canonical.js";
import { loadProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import {
  compileProviderSchema,
  validateProviderRequest,
} from "../src/core/standardRail/schema.js";
import {
  buildGlobalPolicyFixture,
  buildRuntimeHeadFixture,
  encodeGlobalPolicy,
  testGatewaySigner,
} from "./runtimeCatalogFixture.js";
import {
  hash,
  providerWalletKey,
  standardEnvironment,
} from "./standardRailOutcomeFixture.js";

const policy = {
  paidSkills: [{ serviceSlug: "dummy", skillId: "echo" }],
} as const;

async function catalogEnvironment() {
  const env = standardEnvironment();
  const globalPolicy = await buildGlobalPolicyFixture();
  env.STANDARD_RAIL_GATEWAY_SIGNER = testGatewaySigner;
  env.STANDARD_RAIL_GATEWAY_ORIGIN = "https://gateway.example";
  env.STANDARD_RAIL_GLOBAL_POLICY_JSON = encodeGlobalPolicy(globalPolicy);
  env.STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH = hash("3");
  const head = buildRuntimeHeadFixture({
    globalPolicy,
    serviceSlug: "dummy",
    skillId: "echo",
    agentWallet: privateKeyToAccount(providerWalletKey).address,
    pricing: { USDC: { type: "one-time", fixed_amount: "10000" } },
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["message"],
      additionalProperties: false,
    },
  });
  return { env, globalPolicy, head };
}

describe("minimal standard-rail configuration", () => {
  it("loads one fixed-price recipe-bound runtime listing", async () => {
    const { env, head } = await catalogEnvironment();
    const config = await loadProviderStandardRailConfig(policy, env, {
      headsOverride: [head],
    });
    expect([...config.outcomes.keys()]).toEqual(["echo"]);
    expect(config.outcomes.get("echo")).toMatchObject({
      serviceSlug: "dummy",
      skillId: "echo",
      pricingMode: "fixed",
      fixedGrossAmount: "10000",
      bindingProfile: "recipe-bound-v2",
      listingManifestHash: head.runtimeCommitmentHash,
    });
    expect(config.providerAuthorityKey).toBe(config.terminalAttestationKey);
  });

  it("boots before onboarding with a stable missing-listing warning", async () => {
    const { env } = await catalogEnvironment();
    const warnings: string[] = [];
    const config = await loadProviderStandardRailConfig(policy, env, {
      headsOverride: [],
      warn: (message) => warnings.push(message),
    });
    expect(config.outcomes.size).toBe(0);
    expect(warnings).toEqual([
      "installed paid skill dummy:echo has no promoted runtime listing yet — " +
        "not purchasable until registration",
    ]);
  });

  it("rejects non-fixed pricing and catalog heads for foreign skills", async () => {
    const { env, globalPolicy } = await catalogEnvironment();
    const nonFixed = buildRuntimeHeadFixture({
      globalPolicy,
      serviceSlug: "dummy",
      skillId: "echo",
      agentWallet: privateKeyToAccount(providerWalletKey).address,
    });
    await expect(loadProviderStandardRailConfig(policy, env, {
      headsOverride: [nonFixed],
    })).rejects.toThrow(/fixed pricing/);

    const foreign = buildRuntimeHeadFixture({
      globalPolicy,
      serviceSlug: "foreign",
      skillId: "echo",
      agentWallet: privateKeyToAccount(providerWalletKey).address,
      pricing: { USDC: { type: "one-time", fixed_amount: "10000" } },
    });
    await expect(loadProviderStandardRailConfig(policy, env, {
      headsOverride: [foreign],
    })).rejects.toThrow(/not an installed paid skill/);
  });

  it("pins catalog provenance and credential-free HTTPS RPCs", async () => {
    const { env, head } = await catalogEnvironment();
    env.BASE_RPC_FALLBACK_URLS = "https://fallback.example";
    const config = await loadProviderStandardRailConfig(policy, env, {
      headsOverride: [head],
    });
    expect(config.evidenceRpcUrls).toEqual([
      "https://rpc.example/",
      "https://fallback.example/",
    ]);

    const invalid = structuredClone(head);
    invalid.runtimeCommitmentHash = hash("9");
    await expect(loadProviderStandardRailConfig(policy, env, {
      headsOverride: [invalid],
    })).rejects.toThrow(/runtime commitment hash/);
  });

  it("requires closed input schemas and rejects extra input", () => {
    const validate = compileProviderSchema({
      type: "object",
      properties: { message: { type: "string", minLength: 1 } },
      required: ["message"],
      additionalProperties: false,
    });
    expect(() => validateProviderRequest(validate, { message: "hello" })).not.toThrow();
    expect(() => validateProviderRequest(validate, {
      message: "hello",
      hidden: true,
    })).toThrow(/schema/);
    expect(() => compileProviderSchema({
      type: "object",
      properties: { nested: { type: "object", properties: {} } },
      additionalProperties: false,
    })).toThrow(/close or bound object/);
  });

  it("keeps the interoperable recipe nonce vector", () => {
    expect(recipeNonce({
      chainId: 84532,
      canonicalToken: "0x1111111111111111111111111111111111111111",
      payer: "0x2222222222222222222222222222222222222222",
      splitter: "0x3333333333333333333333333333333333333333",
      grossAmount: 123456n,
      listingManifestHash: hash("4"),
      providerOfferHash: hash("5"),
      quoteHash: hash("6"),
      canonicalRequestHash: hash("7"),
      orderNonce: hash("8"),
    })).toBe(
      "0x3211fa4ddf9da6c936cf364755153e800ce61ae0418afb54775fc559770ec1a6" as Hex,
    );
  });
});

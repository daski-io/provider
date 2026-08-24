import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  decodeGzipBase64Json,
  encodeGzipBase64Json,
} from "../src/core/standardRail/compressedJson.js";
import { loadProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import { compileProviderSchema, validateProviderRequest } from "../src/core/standardRail/schema.js";
import { recipeNonce } from "../src/core/standardRail/canonical.js";
import { shouldLinkAssetOwnership } from "../src/core/standardRail/dispatch.js";
import { signProviderOutcomeOffer } from "../src/core/standardRail/offer.js";
import { standardSplitterFixture } from "./standardRailOutcomeFixture.js";

const authorityKey = `0x${"11".repeat(32)}` as Hex;
const providerWalletKey = `0x${"44".repeat(32)}` as Hex;
const hash = (byte: string) => `0x${byte.repeat(64)}`;

const outcomeLaunchPolicy = {
  outcomeIds: [
    "dummy-create-note",
    "sample-create-item",
    "sample-regulated-item",
  ],
} as const;

function configuredOutcomes(env: NodeJS.ProcessEnv): Array<Record<string, unknown>> {
  return JSON.parse(decodeGzipBase64Json(env.STANDARD_RAIL_OUTCOMES_JSON!)) as
    Array<Record<string, unknown>>;
}

function environment(): NodeJS.ProcessEnv {
  return {
    PROVIDER_WALLET_PRIVATE_KEY: providerWalletKey,
    BASE_RPC_URL: "https://rpc.example",
    CHAIN_ID: "84532",
    USDC_ADDRESS: "0x6666666666666666666666666666666666666666",
    SANCTIONS_ORACLE_ADDRESS: "0x5555555555555555555555555555555555555555",
    REPUTATION_STORAGE_ADDRESS: "0x4545454545454545454545454545454545454545",
    EAS_ADDRESS: "0x4646464646464646464646464646464646464646",
    EAS_RUNTIME_CODE_HASH: hash("f"),
    EAS_OUTCOME_SCHEMA_UID: hash("e"),
    STANDARD_RAIL_ENVIRONMENT: "testnet",
    STANDARD_RAIL_GATEWAY_AUDIENCE: "https://gateway.example",
    STANDARD_RAIL_GATEWAY_ORIGIN: "https://gateway.example",
    STANDARD_RAIL_PROVIDER_AUDIENCE: "https://provider.example",
    STANDARD_RAIL_GATEWAY_SIGNER: "0x4444444444444444444444444444444444444444",
    STANDARD_RAIL_OUTCOMES_JSON: (() => {
      const outcome = {
      outcomeId: "dummy-create-note",
      serviceSlug: "dummy",
      serviceId: hash("0"),
      skillId: "create-note",
      listingManifestHash: hash("1"),
      providerOfferHash: hash("2"),
      pricingMode: "dynamic",
      fixedGrossAmount: "0",
      quoteMaximumLifetimeSeconds: 120,
      quoteMinimumPaymentWindowSeconds: 30,
      providerControlProfileHash: hash("3"),
      activeRailProfileHash: hash("9"),
      customerIdentityPolicyId: "none",
      ...standardSplitterFixture(),
      tokenRuntimeCodeHash: hash("5"),
      tokenImplementationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      tokenImplementationRuntimeCodeHash: hash("a"),
      tokenImplementationSlot: hash("b"),
      tokenDomainSeparator: hash("c"),
      sanctionsOracleRuntimeCodeHash: hash("d"),
      providerControlledWallets: [],
      maximumSourceLagBlocks: 3,
      maximumLogPageEvents: 10_000,
      listingCommitmentHash: hash("6"),
      outcomeIdHash: hash("7"),
      policyVersionHash: hash("8"),
      listingEpoch: "1",
      providerTerminalAttestationKey: privateKeyToAccount(providerWalletKey).address,
      commissionBps: 500,
      maxOpenOrders: 10,
      dispatchDeadlineSeconds: 300,
      bindingProfile: "recipe-bound-v1",
      requestSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      };
      return encodeGzipBase64Json([
        { ...outcome, outcomeId: "dummy-create-note", serviceSlug: "dummy", skillId: "create-note" },
        { ...outcome, outcomeId: "sample-create-item", serviceSlug: "sample-catalog", skillId: "create-item" },
        { ...outcome, outcomeId: "sample-regulated-item", serviceSlug: "sample-workflow", skillId: "create-record" },
      ]);
    })(),
  };
}

function loadConfig(
  env: NodeJS.ProcessEnv = environment(),
) {
  return loadProviderStandardRailConfig(outcomeLaunchPolicy, env);
}

describe("provider standard rail configuration", () => {
  it("keeps any-payer execution from taking over the asset ownership link", () => {
    expect(shouldLinkAssetOwnership("any-payer")).toBe(false);
    expect(shouldLinkAssetOwnership("owner-only")).toBe(true);
  });

  it("signs a closed provider outcome offer", async () => {
    const offer = await signProviderOutcomeOffer({
      artifactType: "ProviderOutcomeOfferV1",
      schemaVersion: 1,
      environment: "testnet",
      chainId: 84532,
      audience: "https://gateway.example",
      signerKeyId: "provider-authority",
      issuedAt: 100,
      validBefore: 200,
      payload: {
        listingManifestHash: hash("1") as Hex,
        outcomeId: "stock-note-v1",
        skillId: "create-note",
        providerAgentId: "provider-1",
        providerPayee: "0x1111111111111111111111111111111111111111",
        pricingMode: "dynamic",
        fixedGrossAmount: "0",
        quotePolicyHash: hash("2") as Hex,
        capacityPolicyHash: hash("3") as Hex,
        deadlinePolicyHash: hash("4") as Hex,
        deliveryCommitment: hash("5") as Hex,
        termsHash: hash("6") as Hex,
        issuedAt: 100,
        validBefore: 200,
        offerNonce: hash("8") as Hex,
      },
    }, authorityKey);
    const { signature, ...unsignedOffer } = offer;
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    await expect(signProviderOutcomeOffer({
      ...unsignedOffer,
      payload: { ...offer.payload, pricingMode: "unsupported" as "fixed" },
    }, authorityKey)).rejects.toThrow("payload is invalid");
  });
  it("loads consolidated roles and the closed outcome policy", () => {
    const config = loadConfig();
    expect(config?.outcomes.get("dummy-create-note")?.maxOpenOrders).toBe(10);
    expect(config.gatewayDispatchSigner).toBe(config.gatewayQuoteSigner);
    expect(config.providerAuthorityKey).toBe(config.terminalAttestationKey);
  });

  it("accepts the provider's exact outcome set instead of a core-owned service list", () => {
    const env = environment();
    const [outcome] = configuredOutcomes(env);
    if (!outcome) throw new Error("missing outcome fixture");
    outcome.outcomeId = "example-create-note";
    outcome.serviceSlug = "example";
    outcome.skillId = "create-note";
    env.STANDARD_RAIL_OUTCOMES_JSON = encodeGzipBase64Json([outcome]);

    const config = loadProviderStandardRailConfig(
      { outcomeIds: ["example-create-note"] },
      env,
    );
    expect([...config.outcomes.keys()]).toEqual(["example-create-note"]);
  });

  it("rejects duplicate IDs in provider launch policy", () => {
    expect(() => loadProviderStandardRailConfig({
      outcomeIds: [...outcomeLaunchPolicy.outcomeIds, "dummy-create-note"],
    }, environment())).toThrow(/launch outcome policy is invalid/);
  });

  it("requires compressed outcomes configuration", () => {
    const env = environment();
    env.STANDARD_RAIL_OUTCOMES_JSON = "[]";
    expect(() => loadConfig(env)).toThrow(/malformed/);
  });
  it("requires the complete end-of-block activation checkpoint", () => {
    const env = environment();
    const outcomes = configuredOutcomes(env);
    delete outcomes[0]!.splitterActivationBlockHash;
    env.STANDARD_RAIL_OUTCOMES_JSON = encodeGzipBase64Json(outcomes);

    expect(() => loadConfig(env)).toThrow(/fields are invalid/);
  });

  it("rejects a checkpoint before splitter deployment", () => {
    const env = environment();
    const outcomes = configuredOutcomes(env);
    outcomes[0]!.splitterActivationBlockNumber = "122";
    env.STANDARD_RAIL_OUTCOMES_JSON = encodeGzipBase64Json(outcomes);

    expect(() => loadConfig(env)).toThrow(/activation checkpoint/);
  });

  it("rejects raw splitter creation code that does not match local CREATE2 provenance", () => {
    const env = environment();
    const outcomes = configuredOutcomes(env);
    outcomes[0]!.splitterCreationCode = "0x6001";
    env.STANDARD_RAIL_OUTCOMES_JSON = encodeGzipBase64Json(outcomes);

    expect(() => loadConfig(env)).toThrow(/splitter provenance/);
  });

  it("does not accept the V1 lifetime event-budget field", () => {
    const env = environment();
    const outcomes = configuredOutcomes(env);
    outcomes[0]!.maximumIntervalEvents = outcomes[0]!.maximumLogPageEvents;
    delete outcomes[0]!.maximumLogPageEvents;
    env.STANDARD_RAIL_OUTCOMES_JSON = encodeGzipBase64Json(outcomes);

    expect(() => loadConfig(env)).toThrow(/fields are invalid/);
  });

  it("rejects open nested request objects", () => {
    expect(() => compileProviderSchema({
      type: "object",
      properties: { nested: { type: "object", properties: {} } },
      additionalProperties: false,
    })).toThrow(/close object/);
    expect(() => compileProviderSchema({
      type: "object",
      properties: { unconstrained: {} },
      additionalProperties: false,
    })).toThrow(/explicit type/);
    expect(() => compileProviderSchema({
      type: "object",
      properties: { conditional: { anyOf: [{ type: "string" }, { type: "object" }] } },
      additionalProperties: false,
    })).toThrow(/unsupported keyword/);
  });

  it("uses the primary RPC with an optional fallback", () => {
    const env = environment();
    env.BASE_RPC_FALLBACK_URLS = "https://rpc-fallback.example";
    expect(loadConfig(env).evidenceRpcUrls).toEqual([
      "https://rpc.example/",
      "https://rpc-fallback.example/",
    ]);
  });

  it("uses the launch reputation retry schedule without configuration", () => {
    expect(loadConfig().reputationRetryDelaysSeconds)
      .toEqual([5, 60, 3_000, 30_000]);
  });

  it("pins the reviewed EAS runtime code hash", () => {
    expect(loadConfig().easRuntimeCodeHash).toBe(hash("f"));
    for (const invalid of [undefined, "0x1234", `0x${"00".repeat(32)}`]) {
      const env = environment();
      env.EAS_RUNTIME_CODE_HASH = invalid;
      expect(() => loadConfig(env)).toThrow(/EAS_RUNTIME_CODE_HASH/);
    }
  });

  it("rejects outcome pricing that cannot be independently enforced", () => {
    const env = environment();
    const outcomes = configuredOutcomes(env);
    outcomes[0]!.fixedGrossAmount = "1000000";
    env.STANDARD_RAIL_OUTCOMES_JSON = encodeGzipBase64Json(outcomes);
    expect(() => loadConfig(env)).toThrow(/pricing policy/);
  });

  it("validates request types and rejects extra fields", () => {
    const validate = compileProviderSchema({
      type: "object",
      properties: { text: { type: "string", minLength: 1 } },
      required: ["text"],
      additionalProperties: false,
    });
    expect(() => validateProviderRequest(validate, { text: "hello" })).not.toThrow();
    expect(() => validateProviderRequest(validate, { text: "hello", hidden: true })).toThrow(/provider outcome schema/);
  });

  it("derives the interoperable recipe nonce", () => {
    expect(recipeNonce({
      chainId: 84532,
      canonicalToken: "0x1111111111111111111111111111111111111111",
      payer: "0x2222222222222222222222222222222222222222",
      splitter: "0x3333333333333333333333333333333333333333",
      grossAmount: 123456n,
      listingManifestHash: hash("4") as Hex,
      providerOfferHash: hash("5") as Hex,
      quoteHash: hash("6") as Hex,
      canonicalRequestHash: hash("7") as Hex,
      orderNonce: hash("8") as Hex,
    })).toBe("0x3211fa4ddf9da6c936cf364755153e800ce61ae0418afb54775fc559770ec1a6");
  });
});

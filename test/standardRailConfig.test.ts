import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { recipeNonce } from "../src/core/standardRail/canonical.js";
import {
  decodeGzipBase64Json,
  encodeGzipBase64Json,
} from "../src/core/standardRail/compressedJson.js";
import { loadProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import { signProviderOutcomeOffer } from "../src/core/standardRail/offer.js";
import {
  compileProviderSchema,
  validateProviderRequest,
} from "../src/core/standardRail/schema.js";
import {
  hash,
  providerWalletKey,
  standardEnvironment,
  standardOutcome,
} from "./standardRailOutcomeFixture.js";

const policy = { outcomeIds: ["dummy.echo.v1"] } as const;

describe("minimal standard-rail configuration", () => {
  it("loads one fixed-price recipe-bound outcome", () => {
    const config = loadProviderStandardRailConfig(policy, standardEnvironment());
    expect([...config.outcomes.keys()]).toEqual(["dummy.echo.v1"]);
    expect(config.outcomes.get("dummy.echo.v1")).toMatchObject({
      pricingMode: "fixed",
      fixedGrossAmount: "10000",
      bindingProfile: "recipe-bound-v1",
    });
    expect(config.providerAuthorityKey).toBe(config.terminalAttestationKey);
  });

  it("rejects dynamic pricing and launch-set drift", () => {
    const env = standardEnvironment();
    env.STANDARD_RAIL_OUTCOMES_JSON = encodeGzipBase64Json([{
      ...standardOutcome(),
      pricingMode: "dynamic",
      fixedGrossAmount: "0",
      quoteMaximumLifetimeSeconds: 120,
      quoteMinimumPaymentWindowSeconds: 30,
    }]);
    expect(() => loadProviderStandardRailConfig(policy, env)).toThrow(/fixed/);
    expect(() => loadProviderStandardRailConfig(
      { outcomeIds: ["another-outcome"] },
      standardEnvironment(),
    )).toThrow(/providerLaunchPolicy/);
  });

  it("requires compressed, duplicate-key-free outcome JSON", () => {
    const env = standardEnvironment();
    env.STANDARD_RAIL_OUTCOMES_JSON = JSON.stringify([standardOutcome()]);
    expect(() => loadProviderStandardRailConfig(policy, env)).toThrow(/malformed/);
    expect(decodeGzipBase64Json(standardEnvironment().STANDARD_RAIL_OUTCOMES_JSON!))
      .toContain("dummy.echo.v1");
  });

  it("pins splitter CREATE2 provenance and credential-free HTTPS RPCs", () => {
    const env = standardEnvironment();
    env.STANDARD_RAIL_OUTCOMES_JSON = encodeGzipBase64Json([{
      ...standardOutcome(),
      splitterCreationCode: "0x6001",
    }]);
    expect(() => loadProviderStandardRailConfig(policy, env)).toThrow(/provenance/);
    const fallback = standardEnvironment();
    fallback.BASE_RPC_FALLBACK_URLS = "https://fallback.example";
    expect(loadProviderStandardRailConfig(policy, fallback).evidenceRpcUrls).toEqual([
      "https://rpc.example/",
      "https://fallback.example/",
    ]);
  });

  it("signs only fixed provider offers", async () => {
    const signed = await signProviderOutcomeOffer({
      artifactType: "ProviderOutcomeOfferV1",
      schemaVersion: 1,
      environment: "testnet",
      chainId: 84532,
      audience: "https://gateway.example",
      signerKeyId: "provider",
      issuedAt: 100,
      validBefore: 200,
      payload: {
        listingManifestHash: hash("1"),
        outcomeId: "dummy.echo.v1",
        skillId: "echo",
        providerAgentId: "1",
        providerPayee: "0x1111111111111111111111111111111111111111",
        pricingMode: "fixed",
        fixedGrossAmount: "10000",
        quotePolicyHash: hash("2"),
        capacityPolicyHash: hash("3"),
        deadlinePolicyHash: hash("4"),
        deliveryCommitment: hash("5"),
        termsHash: hash("6"),
        issuedAt: 100,
        validBefore: 200,
        offerNonce: hash("7"),
      },
    }, providerWalletKey);
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
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
    })).toThrow(/close object/);
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

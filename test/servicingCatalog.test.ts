import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { loadProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import { DEFAULT_FULFILLMENT_SECONDS } from "../src/core/standardRail/catalogOutcomes.js";
import { parseRetainedSigningKeys, parseServicingAudiences } from "../src/core/standardRail/retainedConfig.js";
import {
  buildGlobalPolicyFixture,
  buildRuntimeHeadFixture,
  encodeGlobalPolicy,
  testGatewaySigner,
} from "./runtimeCatalogFixture.js";
import { hash, providerWalletKey, standardEnvironment } from "./standardRailOutcomeFixture.js";

const policy = { paidSkills: [{ serviceSlug: "dummy", skillId: "echo" }] } as const;
const previousKey = `0x${"6c".repeat(32)}` as Hex;
const previousWallet = privateKeyToAccount(previousKey).address;
const currentWallet = privateKeyToAccount(providerWalletKey).address;

async function versions() {
  const env = standardEnvironment();
  const globalPolicy = await buildGlobalPolicyFixture();
  env.STANDARD_RAIL_GATEWAY_SIGNER = testGatewaySigner;
  env.STANDARD_RAIL_GATEWAY_ORIGIN = "https://gateway.example";
  env.STANDARD_RAIL_GLOBAL_POLICY_JSON = encodeGlobalPolicy(globalPolicy);
  env.STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH = hash("3");
  const version = (epoch: string, wallet: typeof currentWallet, amount: string,
    deadlines?: { dispatchSeconds?: number; fulfillmentSeconds?: number }, serviceSlug = "dummy") =>
    buildRuntimeHeadFixture({
      globalPolicy, serviceSlug, skillId: "echo", agentWallet: wallet, listingEpoch: epoch,
      pricing: { USDC: { type: "one-time", fixed_amount: amount } }, deadlines,
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", minLength: 1, maxLength: 500 } },
        required: ["message"],
        additionalProperties: false,
      },
    });
  return {
    env,
    // v1 predates explicit deadlines and the wallet rotation; v2 is the head.
    v1: version("1", previousWallet, "5000"),
    v2: version("2", currentWallet, "10000", { dispatchSeconds: 300, fulfillmentSeconds: 900 }),
    foreign: version("3", currentWallet, "10000", undefined, "retired"),
  };
}

describe("servicing catalog of installed listing versions", () => {
  it("sells only heads but services every version by its runtime commitment hash", async () => {
    const { env, v1, v2 } = await versions();
    env.PROVIDER_RETAINED_WALLET_PRIVATE_KEYS = previousKey;
    const config = await loadProviderStandardRailConfig(policy, env, {
      versionsOverride: [{ ...v1, supersededAt: new Date(1) }, { ...v2, supersededAt: null }],
    });
    expect([...config.outcomes.values()].map((outcome) => outcome.listingManifestHash))
      .toEqual([v2.runtimeCommitmentHash]);
    expect(config.servicing.get(v1.runtimeCommitmentHash)).toMatchObject({
      fixedGrossAmount: "5000",
      fulfillmentSeconds: DEFAULT_FULFILLMENT_SECONDS,
      providerTerminalAttestationKey: previousWallet,
    });
    expect(config.servicing.get(v2.runtimeCommitmentHash)?.fulfillmentSeconds).toBe(900);
    expect(config.listingWallets.get(v1.runtimeCommitmentHash)).toBe(previousWallet);
    expect([...config.retainedSigningKeys.keys()]).toEqual([previousWallet]);
    expect(config.unserviceable.size).toBe(0);
  });

  it("records why a superseded version cannot be serviced instead of failing boot", async () => {
    const { env, v2, foreign, v1 } = await versions();
    const tampered = { ...v1, runtimeCommitment: { ...v1.runtimeCommitment, listingEpoch: "9" } };
    const config = await loadProviderStandardRailConfig({
      paidSkills: [...policy.paidSkills],
    }, env, {
      versionsOverride: [
        { ...v2, supersededAt: null },
        { ...foreign, supersededAt: new Date(1) },
        { ...tampered, supersededAt: new Date(1) },
      ],
    });
    expect(Object.fromEntries(config.unserviceable)).toEqual({
      [foreign.runtimeCommitmentHash]: "skill_not_installed",
      [v1.runtimeCommitmentHash]: "definition_invalid",
    });
    expect(config.servicing.has(v1.runtimeCommitmentHash)).toBe(false);
    // Its wallet is still known, so its claims keep being signed.
    expect(config.listingWallets.get(v1.runtimeCommitmentHash)).toBe(previousWallet);
  });

  it("still refuses a head this build cannot sell with the current key", async () => {
    const { env, v1 } = await versions();
    await expect(loadProviderStandardRailConfig(policy, env, {
      versionsOverride: [{ ...v1, supersededAt: null }],
    })).rejects.toThrow(/terminal attestation key mismatch/);
  });
});

describe("retained servicing configuration", () => {
  it("parses previous wallet keys by address and refuses unusable lists", () => {
    const env = { PROVIDER_RETAINED_WALLET_PRIVATE_KEYS: ` ${previousKey} ,` };
    expect([...parseRetainedSigningKeys(env, providerWalletKey)]).toEqual([[previousWallet, previousKey]]);
    expect(parseRetainedSigningKeys({}, providerWalletKey).size).toBe(0);
    for (const value of [`0x${"00".repeat(32)}`, "0x1234", `${previousKey},${previousKey}`, providerWalletKey]) {
      expect(() => parseRetainedSigningKeys({ PROVIDER_RETAINED_WALLET_PRIVATE_KEYS: value }, providerWalletKey))
        .toThrow(/PROVIDER_RETAINED_WALLET_PRIVATE_KEYS/);
    }
  });

  it("adds previous provider audiences for servicing calls only", () => {
    const audiences = parseServicingAudiences(
      { STANDARD_RAIL_RETAINED_PROVIDER_AUDIENCES: "https://old.example, https://older.example" },
      "https://provider.example",
    );
    expect([...audiences]).toEqual(["https://provider.example", "https://old.example", "https://older.example"]);
    for (const value of ["https://user:pass@old.example", "ftp://old.example", "https://provider.example", "nope"]) {
      expect(() => parseServicingAudiences(
        { STANDARD_RAIL_RETAINED_PROVIDER_AUDIENCES: value }, "https://provider.example",
      )).toThrow(/STANDARD_RAIL_RETAINED_PROVIDER_AUDIENCES/);
    }
  });
});

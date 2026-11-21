import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { loadProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import { verifyGatewayRequestEnvelope } from "../src/core/standardRail/gatewayEnvelope.js";
import type { StandardRailGlobalPolicy } from "../src/core/standardRail/catalogOutcomes.js";
import {
  AFTER_EXPIRY,
  POLICY_ISSUED_AT,
  POLICY_VALID_BEFORE,
  RAIL_ADMISSION_VALID_BEFORE,
  RAIL_RECOVERY_VALID_BEFORE,
  restoreClock,
  setClock,
} from "./longLivedRailDates.js";
import {
  buildGlobalPolicyFixture,
  buildRuntimeHeadFixture,
  encodeGlobalPolicy,
  signTestEnvelope,
  testGatewaySigner,
} from "./runtimeCatalogFixture.js";
import { hash, providerWalletKey, standardEnvironment } from "./standardRailOutcomeFixture.js";

/*
 * The global rail policy is a long-lived artifact: its envelopes' validBefore
 * dates are kept as signed and never enforced, so a provider keeps starting
 * and selling with the same policy after them. Its signer, network and the
 * listings' policyVersionHash binding are still enforced, and the gateway's
 * short-lived request envelopes still expire.
 */

const launchPolicy = { paidSkills: [{ serviceSlug: "dummy", skillId: "echo" }] } as const;
const policyDates = {
  issuedAt: POLICY_ISSUED_AT,
  validBefore: POLICY_VALID_BEFORE,
  admissionValidBefore: RAIL_ADMISSION_VALID_BEFORE,
  recoveryValidBefore: RAIL_RECOVERY_VALID_BEFORE,
};
const globalPolicy = await buildGlobalPolicyFixture(policyDates);

const head = (policy: StandardRailGlobalPolicy = globalPolicy) => buildRuntimeHeadFixture({
  globalPolicy: policy,
  serviceSlug: "dummy",
  skillId: "echo",
  agentWallet: privateKeyToAccount(providerWalletKey).address,
  pricing: { USDC: { type: "one-time", fixed_amount: "10000" } },
  inputSchema: {
    type: "object",
    properties: { message: { type: "string", minLength: 1, maxLength: 500 } },
    required: ["message"],
    additionalProperties: false,
  },
});

function environment(policy: StandardRailGlobalPolicy = globalPolicy): NodeJS.ProcessEnv {
  return {
    ...standardEnvironment(),
    STANDARD_RAIL_GATEWAY_SIGNER: testGatewaySigner,
    STANDARD_RAIL_GATEWAY_ORIGIN: "https://gateway.example",
    STANDARD_RAIL_GLOBAL_POLICY_JSON: encodeGlobalPolicy(policy),
    STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH: hash("3"),
  };
}

const load = (env = environment(), heads = [head()]) =>
  loadProviderStandardRailConfig(launchPolicy, env, { headsOverride: heads });

afterEach(restoreClock);

describe.each(AFTER_EXPIRY)("a global rail policy past its signed dates, at %s", (clock) => {
  it("starts and builds the catalog outcome with the same rail bindings", async () => {
    const now = setClock(clock);
    expect(now).toBeGreaterThan(POLICY_VALID_BEFORE);
    const config = await load();
    expect([...config.outcomes.keys()]).toEqual(["echo"]);
    expect(config.outcomes.get("echo")).toMatchObject({
      activeRailProfileHash: canonicalHash(globalPolicy.activeRailProfile),
      policyVersionHash: head().runtimeCommitment.policyVersionHash,
    });
  });

  it("still refuses a broken signature, an untrusted signer or another network", async () => {
    setClock(clock);
    const broken = structuredClone(globalPolicy);
    broken.railCapabilityRequirements.signature = `0x${"11".repeat(65)}` as Hex;
    await expect(load(environment(broken))).rejects.toThrow(/RailCapabilityRequirementsV1 signature is invalid/);
    const foreign = await buildGlobalPolicyFixture({ ...policyDates, signerKey: `0x${"55".repeat(32)}` as Hex });
    await expect(load(environment(foreign))).rejects.toThrow(/signature is invalid/);
    const mainnet = await buildGlobalPolicyFixture({ ...policyDates, environment: "mainnet" });
    await expect(load(environment(mainnet))).rejects.toThrow(/domain is invalid/);
  });

  it("still refuses a listing whose policyVersionHash the policy does not reproduce", async () => {
    setClock(clock);
    // Re-signing the policy with new dates changes its hashes, which no existing listing pins.
    const resigned = await buildGlobalPolicyFixture({ ...policyDates, validBefore: POLICY_VALID_BEFORE + 5 * 31_536_000 });
    await expect(load(environment(resigned), [head(globalPolicy)]))
      .rejects.toThrow(/pins a different rail policy than the global bundle reproduces/);
  });

  it("still refuses a gateway request envelope past its own short validBefore", async () => {
    const now = setClock(clock);
    const request = await signTestEnvelope({
      artifactType: "ProviderQuoteRequestV1", schemaVersion: 1, environment: "testnet", chainId: 84_532,
      audience: "https://provider.example", signerKeyId: "gateway-dispatch",
      issuedAt: now, validBefore: now + 60, payload: { orderId: "ord_x" },
    });
    const verify = () => verifyGatewayRequestEnvelope(request, {
      artifactType: "ProviderQuoteRequestV1", payloadKeys: ["orderId"], environment: "testnet",
      chainId: 84_532, audience: "https://provider.example", signers: [testGatewaySigner],
    });
    await expect(verify()).resolves.toMatchObject({ artifactType: "ProviderQuoteRequestV1" });
    vi.setSystemTime((now + 60) * 1_000);
    await expect(verify()).rejects.toThrow(/domain or lifetime is invalid/);
  });
});

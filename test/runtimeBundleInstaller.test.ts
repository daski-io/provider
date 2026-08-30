import {
  concatHex,
  encodeAbiParameters,
  getCreate2Address,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  buildContractExtension,
  serviceContractHash,
} from "../src/core/agentCards/contractExtension.js";
import { config } from "../src/core/config.js";
import { runtimeCommitmentHash } from "../src/core/gatewayRegistration/runtimeCommitment.js";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { validateRuntimeBundleSet } from "../src/installRuntimeBundle.js";
import { dummyService } from "../src/services/dummy/index.js";
import {
  buildGlobalPolicyFixture,
  buildRuntimeHeadFixture,
  encodeGlobalPolicy,
  signTestEnvelope,
  testGatewaySigner,
} from "./runtimeCatalogFixture.js";
import { hash, providerWalletKey } from "./standardRailOutcomeFixture.js";

const gatewayOrigin = "https://gateway.test";
const serviceId = hash("0");

async function validRuntimeBundle() {
  const globalPolicy = await buildGlobalPolicyFixture({ gatewayAudience: gatewayOrigin });
  process.env.STANDARD_RAIL_GATEWAY_ORIGIN = gatewayOrigin;
  process.env.STANDARD_RAIL_GATEWAY_AUDIENCE = gatewayOrigin;
  process.env.STANDARD_RAIL_GATEWAY_SIGNER = testGatewaySigner;
  process.env.STANDARD_RAIL_GLOBAL_POLICY_JSON = encodeGlobalPolicy(globalPolicy);
  process.env.STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH = hash("3");

  const providerSigner = privateKeyToAccount(providerWalletKey).address;
  const extension = buildContractExtension(dummyService, config.BASE_URL, serviceId);
  const localSkill = extension.skills[0]!;
  const head = buildRuntimeHeadFixture({
    globalPolicy,
    gatewayOrigin,
    gatewayAudience: gatewayOrigin,
    providerAgentId: config.PROVIDER_AGENT_ID.toString(),
    serviceId,
    serviceSlug: dummyService.manifest.slug,
    skillId: localSkill.skillId,
    agentWallet: providerSigner,
    pricing: localSkill.contract.pricing as Record<string, unknown>,
    inputSchema: localSkill.contract.inputSchema as Record<string, unknown>,
  });
  head.bundle.skillContract = {
    skillId: localSkill.skillId,
    skillContractHash: localSkill.skillContractHash,
    acceptingNewOrders: localSkill.acceptingNewOrders,
    contract: localSkill.contract as never,
  };
  head.bundle.listing.skillContractHash = localSkill.skillContractHash;
  head.runtimeCommitment.skillContractHash = localSkill.skillContractHash;

  const intent = await signTestEnvelope({
    artifactType: "ProviderServiceRegistrationIntentV1",
    schemaVersion: 1,
    environment: "testnet",
    chainId: config.CHAIN_ID,
    audience: gatewayOrigin,
    signerKeyId: "provider-authority",
    signerKey: providerWalletKey,
    payload: {
      providerAgentId: config.PROVIDER_AGENT_ID.toString(),
      serviceId,
      serviceSlug: dummyService.manifest.slug,
      serviceVersion: dummyService.manifest.version,
      providerPayee: head.runtimeCommitment.providerPayee,
      serviceContractHash: serviceContractHash(extension),
      skillContractSetHash: extension.skillContractSetHash,
      skills: extension.skills.map((skill) => ({
        skillId: skill.skillId,
        skillContractHash: skill.skillContractHash,
      })),
      railPolicyHash: head.runtimeCommitment.policyVersionHash,
      registrationNonce: hash("6"),
    },
  });
  const providerIntentHash = canonicalHash(intent);
  const priorPreparation = head.bundle.listing.preparation!;
  const preparation = await signTestEnvelope({
    artifactType: "GatewayListingPreparationV1",
    schemaVersion: 1,
    environment: "testnet",
    chainId: config.CHAIN_ID,
    audience: gatewayOrigin,
    signerKeyId: "gateway-protocol",
    payload: {
      ...priorPreparation.payload,
      providerAgentId: config.PROVIDER_AGENT_ID.toString(),
      serviceId,
      serviceSlug: dummyService.manifest.slug,
      serviceVersion: dummyService.manifest.version,
      skillContractHash: localSkill.skillContractHash,
      skillContractSetHash: extension.skillContractSetHash,
      providerIntentHash,
    },
  });
  const preparationHash = canonicalHash(preparation);
  head.bundle.intent = intent as never;
  head.bundle.listing.preparation = preparation as never;
  head.runtimeCommitment.providerAgentId = config.PROVIDER_AGENT_ID.toString();
  head.runtimeCommitment.serviceId = serviceId;
  head.runtimeCommitment.providerIntentHash = providerIntentHash;
  head.runtimeCommitment.preparationHash = preparationHash;
  const constructorArgs = encodeAbiParameters(
    [
      { type: "uint256" }, { type: "address" }, { type: "address" },
      { type: "address" }, { type: "uint16" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" },
    ],
    [
      BigInt(config.CHAIN_ID), head.runtimeCommitment.canonicalToken,
      head.runtimeCommitment.providerPayee,
      head.runtimeCommitment.daskiCommissionReceiver,
      head.runtimeCommitment.commissionBps,
      head.runtimeCommitment.policyVersionHash,
      head.runtimeCommitment.listingKey,
      preparationHash,
      BigInt(head.runtimeCommitment.listingEpoch),
    ],
  );
  const splitterAddress = getCreate2Address({
    from: head.runtimeCommitment.splitterFactory!,
    salt: preparation.payload.splitterDeploymentSalt,
    bytecodeHash: keccak256(concatHex([globalPolicy.splitterCreationCode, constructorArgs])),
  });
  head.runtimeCommitment.splitterAddress = splitterAddress;
  head.bundle.listing.splitterAddress = splitterAddress;
  head.runtimeCommitmentHash = runtimeCommitmentHash(head.runtimeCommitment);

  return {
    artifactType: "ProviderRuntimeBundleSetV1" as const,
    schemaVersion: 1 as const,
    gatewayOrigin,
    serviceId,
    versions: [{
      listingId: head.listingId,
      listingKey: head.listingKey,
      skillId: head.skillId,
      paymentRequired: true,
      runtimeCommitmentHash: head.runtimeCommitmentHash,
      runtimeCommitment: head.runtimeCommitment,
      bundle: head.bundle,
    }],
  };
}

describe("Daski-assisted runtime bundle installation", () => {
  it("accepts only a bundle bound to the exact local contract", async () => {
    const artifact = await validRuntimeBundle();
    const validated = await validateRuntimeBundleSet(artifact);
    expect(validated.gatewayOrigin).toBe(gatewayOrigin);
    expect(validated.artifact.serviceId).toBe(serviceId);
    expect(validated.artifact.versions).toHaveLength(1);
  });

  it("rejects duplicate skills and contract drift", async () => {
    const duplicated = await validRuntimeBundle();
    duplicated.versions.push(structuredClone(duplicated.versions[0]!));
    await expect(validateRuntimeBundleSet(duplicated)).rejects.toThrow(/duplicate skill/);

    const drifted = await validRuntimeBundle();
    drifted.versions[0]!.bundle.skillContract!.contract.pricing = {
      USDC: { type: "one-time", fixed_amount: "10001" },
    };
    await expect(validateRuntimeBundleSet(drifted)).rejects.toThrow(/provider build/);
  });

  it("rejects unsigned shape extensions before persistence", async () => {
    const artifact: Awaited<ReturnType<typeof validRuntimeBundle>> & {
      unexpected?: boolean;
    } = await validRuntimeBundle();
    artifact.unexpected = true;
    await expect(validateRuntimeBundleSet(artifact)).rejects.toThrow(/fields are invalid/);
  });
});

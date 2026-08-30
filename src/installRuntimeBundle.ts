import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { getAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./core/config.js";
import {
  checkDatabase,
  closeMigrationPool,
  configureRuntimePrivileges,
  pool,
  runMigrations,
  verifyDatabaseRoleSeparation,
} from "./core/db/pool.js";
import {
  promoteRuntimeListingVersions,
  type RuntimeListingHead,
  type RuntimeListingVersionInput,
} from "./core/gatewayRegistration/runtimeCatalog.js";
import {
  runtimeCommitmentHash,
} from "./core/gatewayRegistration/runtimeCommitment.js";
import {
  buildContractExtension,
  serviceContractHash,
} from "./core/agentCards/contractExtension.js";
import {
  SIGNED_ENVELOPE_KEYS,
  assertExactKeys,
  assertNoDuplicateJsonKeys,
  canonicalHash,
  unsignedEnvelopeHash,
} from "./core/standardRail/canonical.js";
import {
  loadStandardRailGlobalPolicy,
  materializeOutcome,
} from "./core/standardRail/catalogOutcomes.js";
import type { SignedEnvelope } from "./core/standardRail/types.js";
import { redactSensitiveText } from "./core/security/redaction.js";
import { configuredServices } from "./providerServices.js";

interface RuntimeBundleSetV1 {
  artifactType: "ProviderRuntimeBundleSetV1";
  schemaVersion: 1;
  gatewayOrigin: string;
  serviceId: Hex;
  versions: RuntimeListingVersionInput[];
}

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function bytes32(value: string, label: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be bytes32`);
  return value.toLowerCase() as Hex;
}

function origin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password ||
    parsed.pathname !== "/" || parsed.search || parsed.hash
  ) throw new Error("runtime bundle gatewayOrigin must be a credential-free HTTPS origin");
  return parsed.origin;
}

async function verifyEnvelope(
  envelope: SignedEnvelope<unknown>,
  expected: {
    artifactType: string;
    signer: Address;
    environment: string;
    chainId: number;
    audience: string;
    signerKeyId: string;
  },
): Promise<void> {
  assertExactKeys(
    envelope as unknown as Record<string, unknown>,
    SIGNED_ENVELOPE_KEYS,
    `${expected.artifactType} envelope`,
  );
  if (
    envelope.artifactType !== expected.artifactType || envelope.schemaVersion !== 1 ||
    envelope.environment !== expected.environment || envelope.chainId !== expected.chainId ||
    envelope.audience !== expected.audience || envelope.signerKeyId !== expected.signerKeyId ||
    !Number.isSafeInteger(envelope.issuedAt) || !Number.isSafeInteger(envelope.validBefore) ||
    envelope.issuedAt < 1 || envelope.issuedAt > Math.floor(Date.now() / 1_000) + 300 ||
    envelope.validBefore <= envelope.issuedAt ||
    envelope.validBefore <= Math.floor(Date.now() / 1_000)
  ) throw new Error(`${expected.artifactType} domain is invalid`);
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({
      message: {
        raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>),
      },
      signature: envelope.signature,
    });
  } catch {
    throw new Error(`${expected.artifactType} signature is invalid`);
  }
  if (getAddress(recovered) !== getAddress(expected.signer)) {
    throw new Error(`${expected.artifactType} signature is invalid`);
  }
}

export async function validateRuntimeBundleSet(value: unknown): Promise<{
  artifact: RuntimeBundleSetV1;
  gatewayOrigin: string;
}> {
  assertExactKeys(value, [
    "artifactType", "schemaVersion", "gatewayOrigin", "serviceId", "versions",
  ], "runtime bundle set");
  const artifact = value as RuntimeBundleSetV1;
  if (artifact.artifactType !== "ProviderRuntimeBundleSetV1" || artifact.schemaVersion !== 1) {
    throw new Error("runtime bundle set version is unsupported");
  }
  const gatewayOrigin = origin(artifact.gatewayOrigin);
  const expectedOrigin = origin(
    process.env.STANDARD_RAIL_GATEWAY_ORIGIN ?? config.GATEWAY_BASE_URL,
  );
  if (gatewayOrigin !== expectedOrigin) throw new Error("runtime bundle targets another gateway");
  const serviceId = bytes32(artifact.serviceId, "runtime bundle serviceId");
  if (!Array.isArray(artifact.versions) || artifact.versions.length === 0) {
    throw new Error("runtime bundle set must contain at least one listing");
  }

  const services = configuredServices(config.CHAIN_ID);
  const targetSlug = artifact.versions[0]?.bundle?.intent?.payload?.serviceSlug;
  const localService = services.find((service) => service.manifest.slug === targetSlug);
  if (!localService) throw new Error("runtime bundle targets an uninstalled service");
  const extension = buildContractExtension(localService, config.BASE_URL, serviceId);
  const localBySkill = new Map(extension.skills.map((contract) => [
    contract.skillId,
    contract,
  ]));
  const expectedPaid = new Set(localService.skills
    .filter((skill) => BigInt(skill.fixedPriceAtomic) > 0n)
    .map((skill) => skill.id));
  if (expectedPaid.size === 0) throw new Error("runtime bundle service has no paid skills");
  const expectedServiceContractHash = serviceContractHash(extension);
  const covered = new Set<string>();
  const gatewaySigner = getAddress(
    process.env.STANDARD_RAIL_GATEWAY_SIGNER ?? "",
  );
  const environment = process.env.STANDARD_RAIL_ENVIRONMENT?.trim() ||
    (config.CHAIN_ID === 8453 ? "mainnet" : "testnet");
  const audience = process.env.STANDARD_RAIL_GATEWAY_AUDIENCE?.trim() || gatewayOrigin;
  const providerSigner = privateKeyToAccount(
    config.PROVIDER_WALLET_PRIVATE_KEY as Hex,
  ).address;
  const globalPolicy = await loadStandardRailGlobalPolicy({
    environment,
    chainId: config.CHAIN_ID,
    gatewayAudience: audience,
    gatewaySigner,
  });
  const providerControlProfileHash = bytes32(
    process.env.STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH ?? "",
    "STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH",
  );

  for (const version of artifact.versions) {
    if (!version || typeof version !== "object") throw new Error("runtime listing is invalid");
    assertExactKeys(version as unknown as Record<string, unknown>, [
      "listingId", "listingKey", "skillId", "paymentRequired",
      "runtimeCommitmentHash", "runtimeCommitment", "bundle",
    ], "runtime listing version");
    if (typeof version.skillId !== "string" || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(
      version.skillId,
    )) throw new Error("runtime listing skill id is invalid");
    const listingKey = bytes32(version.listingKey, `runtime listing ${version.skillId} key`);
    const commitmentHash = bytes32(
      version.runtimeCommitmentHash,
      `runtime listing ${version.skillId} commitment hash`,
    );
    assertExactKeys(version.runtimeCommitment as unknown as Record<string, unknown>, [
      "artifactType", "schemaVersion", "environment", "chainId", "gatewayAudience",
      "listingId", "listingKey", "listingEpoch", "providerAgentId", "serviceId",
      "skillId", "skillContractHash", "providerIntentHash", "paymentRequired",
      "preparationHash", "controlProfileHash", "policyVersionHash", "canonicalToken",
      "daskiCommissionReceiver", "commissionBps", "providerPayee", "splitterFactory",
      "splitterAddress",
    ], `runtime listing ${version.skillId} commitment`);
    if (!version.paymentRequired) throw new Error("minimal provider accepts paid listings only");
    if (runtimeCommitmentHash(version.runtimeCommitment).toLowerCase() !== commitmentHash) {
      throw new Error(`runtime listing ${version.skillId} commitment hash is invalid`);
    }
    const bundle = version.bundle;
    assertExactKeys(bundle as unknown as Record<string, unknown>, [
      "schemaVersion", "listing", "skillContract", "intent", "splitterTransactionHash",
      "activationCheckpoint", "providerIdentity", "policyRefs",
    ], `runtime listing ${version.skillId} bundle`);
    if (bundle.schemaVersion !== 1) {
      throw new Error(`runtime listing ${version.skillId} bundle version is unsupported`);
    }
    assertExactKeys(bundle.listing as unknown as Record<string, unknown>, [
      "listingId", "listingKey", "skillId", "skillContractHash", "paymentRequired",
      "acceptingNewOrders", "deploymentRequired", "reused", "splitterAddress",
      "preparation", "controlProfile", "transaction",
    ], `runtime listing ${version.skillId} listing`);
    const intent = bundle.intent;
    const preparation = bundle.listing.preparation;
    if (!preparation || !bundle.skillContract || !bundle.activationCheckpoint) {
      throw new Error(`runtime listing ${version.skillId} is incomplete`);
    }
    if (bundle.listing.controlProfile !== null) {
      throw new Error("minimal provider does not accept asset-action control profiles");
    }
    assertExactKeys(bundle.skillContract as unknown as Record<string, unknown>, [
      "skillId", "skillContractHash", "acceptingNewOrders", "contract",
    ], `runtime listing ${version.skillId} skill contract`);
    assertExactKeys(bundle.activationCheckpoint as unknown as Record<string, unknown>, [
      "splitterDeploymentTransactionHash", "splitterDeploymentBlockNumber",
      "splitterDeploymentBlockHash", "splitterRuntimeCodeHash",
      "splitterActivationBlockNumber", "splitterActivationBlockHash",
      "splitterActivationPosition", "splitterStartingTokenBalance",
      "splitterStartingReleaseSequence",
    ], `runtime listing ${version.skillId} activation checkpoint`);
    assertExactKeys(bundle.providerIdentity as unknown as Record<string, unknown>, [
      "agentWallet", "verifiedAtBlock",
    ], `runtime listing ${version.skillId} provider identity`);
    assertExactKeys(bundle.policyRefs as unknown as Record<string, unknown>, [
      "railPolicyHash", "canonicalToken", "splitterFactory",
      "splitterFactoryRuntimeCodeHash", "splitterCreationCodeHash",
    ], `runtime listing ${version.skillId} policy references`);
    assertExactKeys(intent.payload as unknown as Record<string, unknown>, [
      "providerAgentId", "serviceId", "serviceSlug", "serviceVersion", "providerPayee",
      "serviceContractHash", "skillContractSetHash", "skills", "railPolicyHash",
      "registrationNonce",
    ], `runtime listing ${version.skillId} provider intent`);
    assertExactKeys(preparation.payload as unknown as Record<string, unknown>, [
      "registrationId", "listingId", "listingKey", "providerAgentId", "serviceId",
      "serviceSlug", "serviceVersion", "skillId", "skillContractHash",
      "skillContractSetHash", "providerIntentHash", "canonicalToken", "providerPayee",
      "daskiCommissionReceiver", "commissionBps", "splitterFactory",
      "splitterDeploymentSalt", "policyVersionHash", "listingEpoch",
    ], `runtime listing ${version.skillId} gateway preparation`);
    await verifyEnvelope(intent, {
      artifactType: "ProviderServiceRegistrationIntentV1",
      signer: providerSigner,
      environment,
      chainId: config.CHAIN_ID,
      audience,
      signerKeyId: "provider-authority",
    });
    await verifyEnvelope(preparation, {
      artifactType: "GatewayListingPreparationV1",
      signer: gatewaySigner,
      environment,
      chainId: config.CHAIN_ID,
      audience,
      signerKeyId: "gateway-protocol",
    });
    const skillKey = `${intent.payload.serviceSlug}:${version.skillId}` as `${string}:${string}`;
    const local = localBySkill.get(version.skillId);
    if (
      intent.payload.serviceSlug !== localService.manifest.slug ||
      !local || !expectedPaid.has(version.skillId)
    ) {
      throw new Error(`runtime listing ${skillKey} is not an installed paid skill`);
    }
    if (covered.has(version.skillId)) {
      throw new Error(`runtime bundle contains duplicate skill ${version.skillId}`);
    }
    const bundledSkillHash = canonicalHash({
      schemaVersion: 1,
      serviceSlug: localService.manifest.slug,
      serviceVersion: localService.manifest.version,
      skillId: version.skillId,
      contract: bundle.skillContract.contract,
    });
    const intentSkills = intent.payload.skills.map((skill) => {
      assertExactKeys(skill as unknown as Record<string, unknown>, [
        "skillId", "skillContractHash",
      ], "provider intent skill");
      return { skillId: skill.skillId, skillContractHash: skill.skillContractHash };
    }).sort((left, right) => left.skillId.localeCompare(right.skillId));
    const expectedIntentSkills = extension.skills.map((skill) => ({
      skillId: skill.skillId,
      skillContractHash: skill.skillContractHash,
    }));
    const providerIntentHash = canonicalHash(intent);
    const prepared = preparation.payload;
    if (
      intent.payload.providerAgentId !== config.PROVIDER_AGENT_ID.toString() ||
      intent.payload.serviceId.toLowerCase() !== serviceId ||
      intent.payload.serviceVersion !== localService.manifest.version ||
      intent.payload.serviceContractHash.toLowerCase() !== expectedServiceContractHash ||
      intent.payload.skillContractSetHash.toLowerCase() !== extension.skillContractSetHash ||
      canonicalHash(intentSkills) !== canonicalHash(expectedIntentSkills) ||
      version.runtimeCommitment.artifactType !== "RuntimeListingCommitmentV1" ||
      version.runtimeCommitment.schemaVersion !== 1 ||
      version.runtimeCommitment.environment !== environment ||
      version.runtimeCommitment.chainId !== config.CHAIN_ID ||
      version.runtimeCommitment.gatewayAudience !== audience ||
      version.runtimeCommitment.controlProfileHash !== null ||
      version.runtimeCommitment.serviceId.toLowerCase() !== serviceId ||
      version.runtimeCommitment.providerAgentId !== config.PROVIDER_AGENT_ID.toString() ||
      version.runtimeCommitment.skillContractHash.toLowerCase() !== local.skillContractHash ||
      bundle.skillContract.skillContractHash.toLowerCase() !== local.skillContractHash ||
      bundledSkillHash !== local.skillContractHash ||
      bundle.skillContract.skillId !== version.skillId ||
      bundle.skillContract.acceptingNewOrders !== local.acceptingNewOrders ||
      bundle.listing.paymentRequired !== true ||
      bundle.listing.acceptingNewOrders !== local.acceptingNewOrders ||
      version.skillId !== bundle.listing.skillId ||
      version.listingId !== bundle.listing.listingId ||
      listingKey !== bundle.listing.listingKey.toLowerCase() ||
      bundle.listing.skillContractHash.toLowerCase() !== local.skillContractHash ||
      prepared.providerAgentId !== config.PROVIDER_AGENT_ID.toString() ||
      prepared.serviceId.toLowerCase() !== serviceId ||
      prepared.serviceSlug !== localService.manifest.slug ||
      prepared.serviceVersion !== localService.manifest.version ||
      prepared.skillId !== version.skillId ||
      prepared.skillContractHash.toLowerCase() !== local.skillContractHash ||
      prepared.skillContractSetHash.toLowerCase() !== extension.skillContractSetHash ||
      (!bundle.listing.reused && prepared.providerIntentHash.toLowerCase() !== providerIntentHash) ||
      intent.payload.railPolicyHash.toLowerCase() !== prepared.policyVersionHash.toLowerCase() ||
      getAddress(intent.payload.providerPayee) !== getAddress(prepared.providerPayee) ||
      getAddress(bundle.providerIdentity.agentWallet) !== providerSigner ||
      !/^\d+$/.test(bundle.providerIdentity.verifiedAtBlock) ||
      bundle.splitterTransactionHash?.toLowerCase() !==
        bundle.activationCheckpoint.splitterDeploymentTransactionHash.toLowerCase()
    ) throw new Error(`runtime listing ${skillKey} does not match this provider build`);
    const head: RuntimeListingHead = {
      gatewayOrigin,
      serviceId,
      skillId: version.skillId,
      listingId: version.listingId,
      listingKey,
      paymentRequired: true,
      runtimeCommitmentHash: commitmentHash,
      runtimeCommitment: version.runtimeCommitment,
      bundle,
      promotedAt: new Date(0),
    };
    const outcome = materializeOutcome({
      head,
      globalPolicy,
      chainId: config.CHAIN_ID,
      providerControlProfileHash,
    });
    const skill = localService.skills.find((candidate) => candidate.id === version.skillId)!;
    if (outcome.fixedGrossAmount !== skill.fixedPriceAtomic) {
      throw new Error(`runtime listing ${skillKey} price differs from the service manifest`);
    }
    covered.add(version.skillId);
  }
  if (covered.size !== expectedPaid.size || [...expectedPaid].some((key) => !covered.has(key))) {
    throw new Error("runtime bundle set must cover the exact installed paid-skill set");
  }
  return { artifact: { ...artifact, serviceId }, gatewayOrigin };
}

async function main(): Promise<void> {
  const file = option("--file");
  if (!file) throw new Error("--file is required");
  const source = await readFile(file, "utf8");
  if (Buffer.byteLength(source, "utf8") > 4 * 1024 * 1024) {
    throw new Error("runtime bundle file is too large");
  }
  assertNoDuplicateJsonKeys(source);
  const { artifact, gatewayOrigin } = await validateRuntimeBundleSet(JSON.parse(source));
  if (!await checkDatabase()) throw new Error("provider database is unreachable");
  await runMigrations();
  await configureRuntimePrivileges();
  await verifyDatabaseRoleSeparation();
  await closeMigrationPool();
  await promoteRuntimeListingVersions(
    gatewayOrigin,
    artifact.serviceId,
    artifact.versions,
  );
  process.stdout.write(`${JSON.stringify({
    installed: artifact.versions.length,
    gatewayOrigin,
    serviceId: artifact.serviceId,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    process.stderr.write(`runtime bundle installation failed: ${message}\n`);
    process.exitCode = 1;
  }).finally(async () => {
    await closeMigrationPool().catch(() => undefined);
    await pool.end().catch(() => undefined);
  });
}

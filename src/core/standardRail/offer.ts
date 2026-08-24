import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { assertExactKeys, unsignedEnvelopeHash } from "./canonical.js";
import type { ProviderOutcomeOfferV1, SignedEnvelope } from "./types.js";

export type UnsignedProviderOutcomeOffer = Omit<SignedEnvelope<ProviderOutcomeOfferV1>, "signature">;

export async function signProviderOutcomeOffer(
  envelope: UnsignedProviderOutcomeOffer,
  privateKey: Hex,
): Promise<SignedEnvelope<ProviderOutcomeOfferV1>> {
  assertExactKeys(envelope, [
    "artifactType", "schemaVersion", "environment", "chainId", "audience", "signerKeyId",
    "issuedAt", "validBefore", "payload",
  ], "provider outcome offer envelope");
  assertExactKeys(envelope.payload, [
    "listingManifestHash", "outcomeId", "skillId", "providerAgentId", "providerPayee", "pricingMode",
    "fixedGrossAmount", "quotePolicyHash", "capacityPolicyHash", "deadlinePolicyHash",
    "deliveryCommitment", "termsHash", "issuedAt", "validBefore",
    "offerNonce",
  ], "provider outcome offer payload");
  if (
    envelope.artifactType !== "ProviderOutcomeOfferV1" || envelope.schemaVersion !== 1 ||
    !Number.isSafeInteger(envelope.chainId) || envelope.chainId <= 0 ||
    !Number.isSafeInteger(envelope.issuedAt) || !Number.isSafeInteger(envelope.validBefore) ||
    !envelope.environment || !envelope.audience || !envelope.signerKeyId ||
    envelope.issuedAt !== envelope.payload.issuedAt ||
    envelope.validBefore !== envelope.payload.validBefore ||
    envelope.validBefore <= envelope.issuedAt
  ) throw new Error("Provider outcome offer domain is invalid");
  const hashes = [
    envelope.payload.listingManifestHash, envelope.payload.quotePolicyHash,
    envelope.payload.capacityPolicyHash, envelope.payload.deadlinePolicyHash,
    envelope.payload.deliveryCommitment, envelope.payload.termsHash,
    envelope.payload.offerNonce,
  ];
  if (
    hashes.some((value) => !/^0x[0-9a-fA-F]{64}$/.test(value)) ||
    !envelope.payload.outcomeId || !envelope.payload.skillId || !envelope.payload.providerAgentId ||
    !/^0x[0-9a-fA-F]{40}$/.test(envelope.payload.providerPayee) ||
    !["fixed", "dynamic"].includes(envelope.payload.pricingMode) ||
    !/^\d+$/.test(envelope.payload.fixedGrossAmount) ||
    (envelope.payload.pricingMode === "fixed" && BigInt(envelope.payload.fixedGrossAmount) === 0n) ||
    (envelope.payload.pricingMode === "dynamic" && envelope.payload.fixedGrossAmount !== "0")
  ) throw new Error("Provider outcome offer payload is invalid");
  return {
    ...envelope,
    signature: await privateKeyToAccount(privateKey).signMessage({
      message: { raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>) },
    }),
  };
}

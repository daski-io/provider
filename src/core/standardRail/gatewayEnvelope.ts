import { getAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { assertExactKeys, SIGNED_ENVELOPE_KEYS, unsignedEnvelopeHash } from "./canonical.js";
import type { SignedEnvelope } from "./types.js";

/** Key id the gateway uses for quote, intake, dispatch and status requests. */
export const GATEWAY_DISPATCH_KEY_ID = "gateway-dispatch";
const MAX_FUTURE_SKEW_SECONDS = 30;
const MAX_REQUEST_LIFETIME_SECONDS = 120;

export class GatewayEnvelopeError extends Error {
  constructor(readonly failure: "envelope" | "signature", message: string) {
    super(message);
    this.name = "GatewayEnvelopeError";
  }
}

/** Recover the EIP-191 signer of a gateway envelope's canonical unsigned body. */
export async function gatewayEnvelopeSigner(envelope: SignedEnvelope<unknown, 1 | 2>): Promise<Address> {
  let digest: Hex;
  try {
    digest = unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>);
  } catch {
    throw new GatewayEnvelopeError("envelope", "Gateway envelope is not canonical JSON");
  }
  try {
    return getAddress(await recoverMessageAddress({
      message: { raw: digest },
      signature: envelope.signature,
    }));
  } catch {
    throw new GatewayEnvelopeError("signature", "Gateway envelope signature is malformed");
  }
}

/**
 * Authenticate one short-lived gateway request (quote, intake or status).
 * Several envelope types share the gateway dispatch key, so the artifact
 * type, schema version, domain and lifetime are checked before the signature
 * is trusted and before any payload field is interpreted.
 */
export async function verifyGatewayRequestEnvelope<T>(value: unknown, expected: {
  artifactType: string;
  payloadKeys: readonly string[];
  environment: string;
  chainId: number;
  audience: string;
  signer: Address;
}): Promise<SignedEnvelope<T>> {
  const label = expected.artifactType;
  try {
    assertExactKeys(value, SIGNED_ENVELOPE_KEYS, `${label} envelope`);
  } catch {
    throw new GatewayEnvelopeError("envelope", `${label} envelope fields are invalid`);
  }
  const envelope = value as SignedEnvelope<T>;
  const now = Math.floor(Date.now() / 1_000);
  if (
    envelope.artifactType !== expected.artifactType
    || envelope.schemaVersion !== 1
    || envelope.environment !== expected.environment
    || envelope.chainId !== expected.chainId
    || envelope.audience !== expected.audience
    || envelope.signerKeyId !== GATEWAY_DISPATCH_KEY_ID
    || !Number.isSafeInteger(envelope.issuedAt)
    || !Number.isSafeInteger(envelope.validBefore)
    || envelope.issuedAt > now + MAX_FUTURE_SKEW_SECONDS
    || envelope.validBefore <= now
    || envelope.validBefore <= envelope.issuedAt
    || envelope.validBefore - envelope.issuedAt > MAX_REQUEST_LIFETIME_SECONDS
    || envelope.validBefore > now + MAX_REQUEST_LIFETIME_SECONDS
    || typeof envelope.signature !== "string"
  ) throw new GatewayEnvelopeError("envelope", `${label} domain or lifetime is invalid`);
  try {
    assertExactKeys(envelope.payload, expected.payloadKeys, `${label} payload`);
  } catch {
    throw new GatewayEnvelopeError("envelope", `${label} payload fields are invalid`);
  }
  if (await gatewayEnvelopeSigner(envelope) !== getAddress(expected.signer)) {
    throw new GatewayEnvelopeError("signature", `${label} signature is invalid`);
  }
  return envelope;
}

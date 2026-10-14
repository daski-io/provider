import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { assertExactKeys, canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { HASH32_PATTERN, ORDER_ID_PATTERN } from "./dispatchContract.js";
import { GatewayEnvelopeError, verifyGatewayRequestEnvelope } from "./gatewayEnvelope.js";
import { assertBoundedJsonValue, REQUEST_JSON_BUDGET } from "./jsonBounds.js";
import { LifecycleRejectedError, LifecycleUnavailableError } from "./lifecycleErrors.js";
import {
  PayerSignatureError,
  verifyPayerTypedData,
  type PayerSignatureOptions,
  type PayerTypedData,
} from "./payerSignature.js";
import type { SignedEnvelope } from "./types.js";

/** The exact body the gateway posts to the lifecycle URL (service.ts performAction). */
export const LIFECYCLE_BODY_KEYS = [
  "orderId", "providerTaskId", "action", "request", "authorization", "grant", "payer",
  "gatewayAudience",
] as const;
const GRANT_PAYLOAD_KEYS = [
  "orderId", "providerTaskId", "action", "requestHash", "authorizationHash", "payer",
] as const;
/** OrderActionAuthorizationV1 as the buyer signed it: eight challenge fields and the signature. */
const PAYER_AUTHORIZATION_KEYS = [
  "orderId", "action", "method", "absoluteResourceUri", "requestHash", "nonce", "issuedAt",
  "validBefore", "signature",
] as const;
export const GATEWAY_LIFECYCLE_KEY_ID = "gateway-lifecycle";
/** Read capabilities authorize these actions and nothing else. */
export const READ_ACTIONS: ReadonlySet<string> = new Set(["status", "artifact"]);
const AUTHORIZATION_LIFETIME_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 30;
const ORDER_ACTION_TYPES = {
  OrderActionAuthorizationV1: [
    { name: "orderIdHash", type: "bytes32" },
    { name: "actionHash", type: "bytes32" },
    { name: "methodHash", type: "bytes32" },
    { name: "absoluteResourceUriHash", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "audienceHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "validBefore", type: "uint64" },
  ],
} as const;

export interface LifecycleCall {
  orderId: string;
  providerTaskId: string;
  action: string;
  request: Record<string, unknown>;
  authorization: Record<string, unknown>;
  grant: unknown;
  payer: Address;
  gatewayAudience: string;
}

interface LifecycleGrantPayload {
  orderId: unknown;
  providerTaskId: unknown;
  action: unknown;
  requestHash: unknown;
  authorizationHash: unknown;
  payer: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const reject = (reason: ConstructorParameters<typeof LifecycleRejectedError>[0], authenticated: boolean) =>
  new LifecycleRejectedError(reason, authenticated);
const sameHash = (value: unknown, expected: Hex) =>
  typeof value === "string" && HASH32_PATTERN.test(value) && value.toLowerCase() === expected;

/** Shape of the gateway's lifecycle body; nothing in it is trusted yet. */
export function parseLifecycleCall(body: unknown): LifecycleCall {
  try {
    assertExactKeys(body, LIFECYCLE_BODY_KEYS, "lifecycle request");
    const call = body as Record<string, unknown>;
    if (
      typeof call.orderId !== "string" || !ORDER_ID_PATTERN.test(call.orderId)
      || typeof call.providerTaskId !== "string" || call.providerTaskId.length < 1
      || call.providerTaskId.length > 128 || /[\u0000-\u001f\u007f]/.test(call.providerTaskId)
      || typeof call.action !== "string" || !/^[a-z][a-z-]{0,31}$/.test(call.action)
      || !isRecord(call.request) || !isRecord(call.authorization) || !isRecord(call.grant)
      || typeof call.payer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(call.payer)
      || typeof call.gatewayAudience !== "string" || call.gatewayAudience.length > 2_048
    ) throw new Error("lifecycle request is malformed");
    assertBoundedJsonValue(call.request, REQUEST_JSON_BUDGET, "Lifecycle request");
    return { ...(call as unknown as LifecycleCall), payer: getAddress(call.payer) };
  } catch {
    throw reject("request_invalid", false);
  }
}

/**
 * Verify the ProviderLifecycleGrantV1 before anything in the call is
 * interpreted: type, version, domain, provider audience, the
 * `gateway-lifecycle` key id and signer, a lifetime of at most 120 seconds,
 * and the binding of order, task, action, request, authorization and payer.
 */
export async function verifyLifecycleGrant(
  call: LifecycleCall,
  config: ProviderStandardRailConfig,
  chainId: number,
): Promise<SignedEnvelope<LifecycleGrantPayload>> {
  let grant: SignedEnvelope<LifecycleGrantPayload>;
  try {
    grant = await verifyGatewayRequestEnvelope<LifecycleGrantPayload>(call.grant, {
      artifactType: "ProviderLifecycleGrantV1",
      payloadKeys: GRANT_PAYLOAD_KEYS,
      environment: config.environment,
      chainId,
      audience: config.providerAudience,
      signer: config.gatewayLifecycleSigner,
      signerKeyId: GATEWAY_LIFECYCLE_KEY_ID,
    });
  } catch (error) {
    const signature = error instanceof GatewayEnvelopeError && error.failure === "signature";
    throw reject(signature ? "signature" : "grant", false);
  }
  const payload = grant.payload;
  let bound = false;
  try {
    bound = payload.orderId === call.orderId
      && payload.providerTaskId === call.providerTaskId
      && payload.action === call.action
      && sameHash(payload.requestHash, canonicalHash(call.request))
      && sameHash(payload.authorizationHash, canonicalHash(call.authorization))
      && typeof payload.payer === "string" && getAddress(payload.payer) === call.payer
      && call.gatewayAudience === config.gatewayAudience;
  } catch {
    bound = false;
  }
  if (!bound) throw reject("binding", true);
  return grant;
}

function isGatewayActionUri(value: unknown, origin: string, action: string): boolean {
  if (typeof value !== "string" || value.length > 2_048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.origin === origin && !url.username && !url.password
    && !url.search && !url.hash
    && new RegExp(`^(?:/[^/]+)*/orders/[^/]+/actions/${action}$`).test(url.pathname);
}

/**
 * Interpret the authorization a verified grant bound. A read capability
 * stub authorizes only a status or artifact read of exactly that scope with
 * an empty request. A payer-signed OrderActionAuthorizationV1 must name this
 * order, action, request and gateway, have been valid when the gateway
 * issued the grant, and verify for the grant's payer (EOA, or a configured
 * ERC-1271 account). Nothing is consumed: the gateway already spent its nonce.
 */
export async function verifyLifecycleAuthorization(
  call: LifecycleCall,
  grant: SignedEnvelope<LifecycleGrantPayload>,
  context: { config: ProviderStandardRailConfig; chainId: number; payerSignatures: PayerSignatureOptions },
): Promise<"readCapability" | "payerSigned"> {
  const authorization = call.authorization;
  const emptyRequest = Object.keys(call.request).length === 0;
  if (authorization.type === "DaskiReadCap") {
    if (
      Object.keys(authorization).sort().join() !== "scope,type"
      || !READ_ACTIONS.has(call.action) || authorization.scope !== call.action || !emptyRequest
    ) throw reject("authorization", true);
    return "readCapability";
  }
  let typedData: PayerTypedData;
  try {
    assertExactKeys(authorization, PAYER_AUTHORIZATION_KEYS, "payer authorization");
    const { issuedAt, validBefore, nonce } = authorization;
    if (
      authorization.orderId !== call.orderId || authorization.action !== call.action
      || authorization.method !== "POST"
      || !isGatewayActionUri(authorization.absoluteResourceUri, context.config.gatewayOrigin, call.action)
      || !sameHash(authorization.requestHash, canonicalHash(call.request))
      || typeof nonce !== "string" || !HASH32_PATTERN.test(nonce)
      || typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt) || issuedAt < 0
      || typeof validBefore !== "number" || !Number.isSafeInteger(validBefore)
      || validBefore <= issuedAt || validBefore - issuedAt > AUTHORIZATION_LIFETIME_SECONDS
      || issuedAt > grant.issuedAt + CLOCK_SKEW_SECONDS || validBefore <= grant.issuedAt
      || (READ_ACTIONS.has(call.action) && !emptyRequest)
    ) throw new Error("payer authorization does not bind this call");
    typedData = {
      domain: { name: "DaskiStandardOrder", version: "1", chainId: context.chainId },
      types: ORDER_ACTION_TYPES as unknown as PayerTypedData["types"],
      primaryType: "OrderActionAuthorizationV1",
      message: {
        orderIdHash: keccak256(stringToHex(call.orderId)),
        actionHash: keccak256(stringToHex(call.action)),
        methodHash: keccak256(stringToHex("POST")),
        absoluteResourceUriHash: keccak256(stringToHex(authorization.absoluteResourceUri as string)),
        requestHash: canonicalHash(call.request),
        audienceHash: keccak256(stringToHex(context.config.gatewayAudience)),
        nonce: nonce as Hex,
        issuedAt: BigInt(issuedAt),
        validBefore: BigInt(validBefore),
      },
    };
  } catch {
    throw reject("authorization", true);
  }
  try {
    await verifyPayerTypedData(
      { payer: call.payer, typedData, signature: authorization.signature },
      context.payerSignatures,
    );
  } catch (error) {
    if (error instanceof PayerSignatureError && error.retryable) {
      throw new LifecycleUnavailableError("Payer signature verification is unavailable", error);
    }
    throw reject("authorization", true);
  }
  return "payerSigned";
}

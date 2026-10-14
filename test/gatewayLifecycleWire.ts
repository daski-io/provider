import { getAddress, keccak256, recoverMessageAddress, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { compileProviderSchema, validateProviderRequest } from "../src/core/standardRail/schema.js";
import {
  gatewayKey,
  nowSeconds,
  operationsSchema,
  providerAuthority,
  signGatewayEnvelope,
  type ProviderAnswer,
} from "./gatewayWire.js";

/**
 * Port of the gateway's lifecycle side at daski-io/gateway 1548cc0
 * (service.ts performAction/applyLifecycleResult, orderAuthorization.ts,
 * lifecycleRefusal.ts): how it builds a lifecycle call and how it judges the
 * provider's answer. Nothing here is imported from the gateway at runtime.
 */
export const GATEWAY_AUDIENCE = "https://gateway.example";
export const LIFECYCLE_HEADERS = { "content-type": "application/json", "daski-order-status-view": "1" };

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

/** The payer's EIP-712 OrderActionAuthorizationV1 for one order action. */
export async function payerAuthorization(args: {
  payerKey: Hex;
  orderId: string;
  action: string;
  request: Record<string, unknown>;
  issuedAt?: number;
  audience?: string;
  chainId?: number;
  handle?: string;
}) {
  const issuedAt = args.issuedAt ?? nowSeconds() - 5;
  const challenge = {
    orderId: args.orderId,
    action: args.action,
    method: "POST" as const,
    absoluteResourceUri: `${GATEWAY_AUDIENCE}/orders/${args.handle ?? "orderHandle-1"}/actions/${args.action}`,
    requestHash: canonicalHash(args.request),
    nonce: keccak256(stringToHex(`nonce:${args.orderId}:${args.action}:${issuedAt}`)),
    issuedAt,
    validBefore: issuedAt + 300,
  };
  const signature = await privateKeyToAccount(args.payerKey).signTypedData({
    domain: { name: "DaskiStandardOrder", version: "1", chainId: args.chainId ?? 84532 },
    types: ORDER_ACTION_TYPES,
    primaryType: "OrderActionAuthorizationV1",
    message: {
      orderIdHash: keccak256(stringToHex(challenge.orderId)),
      actionHash: keccak256(stringToHex(challenge.action)),
      methodHash: keccak256(stringToHex(challenge.method)),
      absoluteResourceUriHash: keccak256(stringToHex(challenge.absoluteResourceUri)),
      requestHash: challenge.requestHash,
      audienceHash: keccak256(stringToHex(args.audience ?? GATEWAY_AUDIENCE)),
      nonce: challenge.nonce,
      issuedAt: BigInt(challenge.issuedAt),
      validBefore: BigInt(challenge.validBefore),
    },
  });
  return { ...challenge, signature };
}

/** The body the gateway posts to the lifecycle URL, with its ProviderLifecycleGrantV1. */
export async function gatewayLifecycleCall(args: {
  orderId: string;
  providerTaskId: string;
  action: string;
  payer: Address;
  request?: Record<string, unknown>;
  authorization?: Record<string, unknown>;
  issuedAt?: number;
  grant?: Partial<Parameters<typeof signGatewayEnvelope>[0]>;
  grantPayload?: Record<string, unknown>;
}) {
  const request = args.request ?? {};
  const authorization = args.authorization ?? { type: "DaskiReadCap", scope: args.action };
  const issuedAt = args.issuedAt ?? nowSeconds();
  const grant = await signGatewayEnvelope({
    artifactType: "ProviderLifecycleGrantV1",
    signerKeyId: "gateway-lifecycle",
    issuedAt,
    validBefore: issuedAt + 120,
    payload: {
      orderId: args.orderId,
      providerTaskId: args.providerTaskId,
      action: args.action,
      requestHash: canonicalHash(request),
      authorizationHash: canonicalHash(authorization),
      payer: getAddress(args.payer),
      ...args.grantPayload,
    },
    privateKey: gatewayKey,
    ...args.grant,
  });
  return {
    orderId: args.orderId,
    providerTaskId: args.providerTaskId,
    action: args.action,
    request,
    authorization,
    grant,
    payer: getAddress(args.payer),
    gatewayAudience: GATEWAY_AUDIENCE,
  };
}

const LIFECYCLE_STATES = ["submitted", "dispatching", "working", "input-required", "completed", "failed", "canceled"];

export interface StoredTerminal {
  taskId: string;
  state: string;
  resultHash: Hex;
  completedAt: number;
}

/** Port of applyLifecycleResult's validation of a 2xx lifecycle answer. */
export async function acceptLifecycleAnswerAsGateway(args: {
  value: unknown;
  action: "status" | "artifact";
  orderId: string;
  providerTaskId: string;
  resultSchema: Record<string, unknown>;
  storedTerminal?: StoredTerminal;
  providerAuthorityKey?: Address;
  providerTerminalAttestationKey?: Address;
  now?: number;
}) {
  const now = args.now ?? nowSeconds();
  const response = args.value as Record<string, unknown> & {
    terminalAttestation?: { payload?: Record<string, unknown>; signature?: unknown };
  };
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("malformed");
  const keys = ["orderId", "taskId", "state", "signature", "operations"];
  for (const optional of ["result", "terminalAttestation", "inputRequest", "documents"]) {
    if (optional in response) keys.push(optional);
  }
  if (Object.keys(response).sort().join() !== keys.sort().join()) {
    throw new Error("provider lifecycle response fields are invalid");
  }
  const operations = operationsSchema.parse(response.operations);
  if (operations.observedAt > now + 30 || operations.observedAt < now - 300) {
    throw new Error("provider_operations_observation_stale");
  }
  if ("inputRequest" in response || "documents" in response) throw new Error("lite adds no views");
  if (
    response.orderId !== args.orderId || response.taskId !== args.providerTaskId
    || typeof response.signature !== "string" || !LIFECYCLE_STATES.includes(String(response.state))
  ) throw new Error("PROVIDER_LIFECYCLE_BINDING_INVALID");
  const { signature, ...signed } = response;
  const authority = await recoverMessageAddress({ message: { raw: canonicalHash(signed) }, signature: signature as Hex });
  if (getAddress(authority) !== getAddress(args.providerAuthorityKey ?? providerAuthority)) {
    throw new Error("PROVIDER_LIFECYCLE_SIGNATURE_INVALID");
  }
  if (args.action === "status" && "result" in response) throw new Error("PROVIDER_LIFECYCLE_UNEXPECTED_CONTENT");
  if (args.action === "artifact" && !("result" in response)) throw new Error("PROVIDER_ARTIFACT_MISSING");
  if (args.action === "artifact" && response.state !== "completed") throw new Error("PROVIDER_ARTIFACT_NOT_FULFILLED");
  if ("result" in response) {
    // A lite result has no string `id`, so the gateway validates it whole.
    validateProviderRequest(compileProviderSchema(args.resultSchema), response.result, "Response");
  }
  if (!["completed", "failed", "canceled"].includes(String(response.state))) {
    if ("terminalAttestation" in response) throw new Error("attestation on a pending answer");
    return { body: response, operations, attestation: null };
  }
  const attestation = response.terminalAttestation;
  if (!attestation?.payload || typeof attestation.signature !== "string"
    || Object.keys(attestation).sort().join() !== "payload,signature"
    || Object.keys(attestation.payload).sort().join() !== "completedAt,orderId,resultHash,state,taskId") {
    throw new Error("PROVIDER_TERMINAL_ATTESTATION_MISSING");
  }
  const payload = attestation.payload;
  if (
    typeof payload.completedAt !== "number" || !Number.isSafeInteger(payload.completedAt)
    || payload.completedAt <= 0 || payload.completedAt > now + 30
  ) throw new Error("PROVIDER_TERMINAL_ATTESTATION_TIME_INVALID");
  const terminalSigner = await recoverMessageAddress({
    message: { raw: canonicalHash(payload) },
    signature: attestation.signature as Hex,
  });
  if (
    getAddress(terminalSigner) !== getAddress(args.providerTerminalAttestationKey ?? providerAuthority)
    || payload.orderId !== args.orderId || payload.taskId !== args.providerTaskId
    || payload.state !== response.state
  ) throw new Error("PROVIDER_TERMINAL_ATTESTATION_INVALID");
  if (args.storedTerminal && (
    args.storedTerminal.taskId !== payload.taskId || args.storedTerminal.state !== payload.state
    || args.storedTerminal.resultHash !== payload.resultHash
    || args.storedTerminal.completedAt !== payload.completedAt
  )) throw new Error("provider_original_terminal_changed");
  return { body: response, operations, attestation: payload as unknown as StoredTerminal & { orderId: string } };
}

const NAMED_REFUSALS = [
  { status: 409, error: "artifact_unavailable", code: "ARTIFACT_NOT_AVAILABLE", actions: ["artifact"] },
  { status: 409, error: "unsupported_action", code: "ORDER_ACTION_UNSUPPORTED" },
  { status: 409, error: "action_conflict", code: "ORDER_ACTION_CONFLICT" },
  { status: 503, error: "lifecycle_unavailable", code: "PROVIDER_LIFECYCLE_UNAVAILABLE" },
];

/** Port of providerLifecycleRefusal: the buyer-facing code for a non-2xx answer. */
export function classifyLifecycleRefusal(action: string, answer: ProviderAnswer): string {
  const candidates = NAMED_REFUSALS.filter((refusal) =>
    refusal.status === answer.status && (!refusal.actions || refusal.actions.includes(action)));
  const mediaType = answer.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (candidates.length > 0 && mediaType === "application/json" && !answer.contentEncoding) {
    try {
      const body = JSON.parse(answer.text) as unknown;
      if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1) {
        const named = candidates.find((refusal) => (body as Record<string, unknown>).error === refusal.error);
        if (named) return named.code;
      }
    } catch {
      // An unreadable refusal stays internal.
    }
  }
  return "INTERNAL_ERROR";
}

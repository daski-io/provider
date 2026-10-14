import { getAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { canonicalHash, unsignedEnvelopeHash } from "../src/core/standardRail/canonical.js";
import type { SignedEnvelope } from "../src/core/standardRail/types.js";

/**
 * Minimal port of the gateway consumer contract at daski-io/gateway 8f15201
 * (src/standardRail/signing.ts, service.ts resolveGrossAmount, intake.ts).
 * Tests construct requests and validate provider answers exactly as the
 * gateway does; nothing here is imported from the gateway at runtime.
 */
export const gatewayKey = `0x${"77".repeat(32)}` as Hex;
export const gatewaySigner = privateKeyToAccount(gatewayKey).address;
export const providerKey = `0x${"44".repeat(32)}` as Hex;
export const providerAuthority = privateKeyToAccount(providerKey).address;
export const FIXED_READINESS_QUOTE_MAX_SECONDS = 300;

export const nowSeconds = () => Math.floor(Date.now() / 1_000);

export async function signGatewayEnvelope<T, V extends 1 | 2 = 1>(args: {
  artifactType: string;
  schemaVersion?: V;
  environment?: string;
  chainId?: number;
  audience?: string;
  signerKeyId?: string;
  issuedAt: number;
  validBefore: number;
  payload: T;
  privateKey?: Hex;
}): Promise<SignedEnvelope<T, V>> {
  const unsigned = {
    artifactType: args.artifactType,
    schemaVersion: (args.schemaVersion ?? 1) as V,
    environment: args.environment ?? "testnet",
    chainId: args.chainId ?? 84532,
    audience: args.audience ?? "https://provider.example",
    signerKeyId: args.signerKeyId ?? "gateway-dispatch",
    issuedAt: args.issuedAt,
    validBefore: args.validBefore,
    payload: args.payload,
  };
  const signature = await privateKeyToAccount(args.privateKey ?? gatewayKey).signMessage({
    message: { raw: unsignedEnvelopeHash(unsigned as unknown as Record<string, unknown>) },
  });
  return { ...unsigned, signature };
}

export interface GatewayListing {
  outcomeId: string;
  listingManifestHash: Hex;
  fixedGrossAmount: string;
  commissionBps: number;
  providerAuthorityKey: Address;
  minimumPaymentWindowSeconds: number;
  requestSchema: unknown;
}

/** The ProviderQuoteRequestV1 envelope the gateway posts as `{request}`. */
export function gatewayQuoteRequest(args: {
  listing: GatewayListing;
  request: unknown;
  payer: Hex | null;
  issuedAt?: number;
  overrides?: Partial<Parameters<typeof signGatewayEnvelope>[0]>;
}) {
  const now = args.issuedAt ?? nowSeconds();
  return signGatewayEnvelope({
    artifactType: "ProviderQuoteRequestV1",
    issuedAt: now,
    validBefore: now + 60,
    payload: {
      outcomeId: args.listing.outcomeId,
      listingManifestHash: args.listing.listingManifestHash,
      requestHash: canonicalHash(args.request),
      request: args.request,
      payer: args.payer,
    },
    ...args.overrides,
  });
}

const sortedKeys = (value: object) => Object.keys(value).sort().join(",");

/**
 * Port of the success branch of resolveGrossAmount: exact keys, literal payer
 * echo, receipt-time windows, releasable amount, provider signature and the
 * fixed price. Returns the payer-inclusive providerQuoteHash the gateway puts
 * into QuoteV1.
 */
export async function acceptQuoteAsGateway(args: {
  listing: GatewayListing;
  body: unknown;
  request: unknown;
  payer: Hex | null;
  receivedAt?: number;
}): Promise<{ providerQuoteHash: Hex; issuedAt: number; validBefore: number; grossAmount: string }> {
  const quote = args.body as Record<string, unknown>;
  if (sortedKeys(quote) !== "grossAmount,issuedAt,listingManifestHash,outcomeId,payer,requestHash,signature,validBefore") {
    throw new Error("provider quote response fields are invalid");
  }
  const requestHash = canonicalHash(args.request);
  if (
    quote.outcomeId !== args.listing.outcomeId || quote.payer !== args.payer
    || quote.listingManifestHash !== args.listing.listingManifestHash
    || quote.requestHash !== requestHash || typeof quote.grossAmount !== "string"
    || !/^[1-9][0-9]*$/.test(quote.grossAmount) || typeof quote.issuedAt !== "number"
    || !Number.isSafeInteger(quote.issuedAt) || typeof quote.validBefore !== "number"
    || !Number.isSafeInteger(quote.validBefore) || typeof quote.signature !== "string"
  ) throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  const receivedAt = args.receivedAt ?? nowSeconds();
  if (
    quote.issuedAt > receivedAt + 30 || quote.issuedAt < receivedAt - 30
    || quote.validBefore <= receivedAt + args.listing.minimumPaymentWindowSeconds
    || quote.validBefore > quote.issuedAt + FIXED_READINESS_QUOTE_MAX_SECONDS
  ) throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  const bps = BigInt(args.listing.commissionBps);
  if (BigInt(quote.grossAmount) < (10_000n + bps - 1n) / bps) throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  const providerQuoteHash = canonicalHash({
    outcomeId: quote.outcomeId,
    listingManifestHash: quote.listingManifestHash,
    requestHash: quote.requestHash,
    grossAmount: quote.grossAmount,
    payer: quote.payer,
    issuedAt: quote.issuedAt,
    validBefore: quote.validBefore,
  });
  const signer = await recoverMessageAddress({
    message: { raw: providerQuoteHash },
    signature: quote.signature as Hex,
  });
  if (getAddress(signer) !== getAddress(args.listing.providerAuthorityKey)) {
    throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  }
  if (quote.grossAmount !== args.listing.fixedGrossAmount) throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  return {
    providerQuoteHash,
    issuedAt: quote.issuedAt,
    validBefore: quote.validBefore,
    grossAmount: quote.grossAmount,
  };
}

/** Port of the 4xx branch: only bounded `fieldErrors` entries are read. */
export function gatewayQuoteFieldErrors(status: number, body: unknown) {
  if (status < 400 || status >= 500) return { code: "PROVIDER_QUOTE_UNAVAILABLE", fieldErrors: undefined };
  const rejection = body as { fieldErrors?: unknown };
  const fieldErrors = Array.isArray(rejection?.fieldErrors)
    ? rejection.fieldErrors.slice(0, 32).flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const value = item as Record<string, unknown>;
      if (typeof value.path !== "string" || typeof value.rule !== "string"
        || typeof value.message !== "string") return [];
      return [value];
    })
    : undefined;
  return { code: "PROVIDER_QUOTE_REJECTED", fieldErrors };
}

/** The ProviderIntakeRequestV1 envelope the gateway posts to the quote URL. */
export function gatewayIntakeRequest(listing: GatewayListing, request: Record<string, unknown>) {
  const now = nowSeconds();
  return signGatewayEnvelope({
    artifactType: "ProviderIntakeRequestV1",
    issuedAt: now,
    validBefore: now + 60,
    payload: {
      outcomeId: listing.outcomeId,
      listingManifestHash: listing.listingManifestHash,
      requestHash: canonicalHash(request),
      request,
    },
  });
}

/** Port of getIntakeRequirements' response verification. */
export async function acceptIntakeAsGateway(
  listing: GatewayListing,
  request: Record<string, unknown>,
  value: unknown,
): Promise<Record<string, unknown>> {
  const now = nowSeconds();
  const result = value as Record<string, unknown>;
  const keys = ["outcomeId", "listingManifestHash", "requestHash", "requestSchema", "requiredFields",
    "selectorsRequired", "normalizedSelectors", "fieldErrors", "supported", "issuedAt", "validBefore", "signature"];
  if (Object.keys(result).sort().join() !== keys.sort().join()
    || result.outcomeId !== listing.outcomeId || result.listingManifestHash !== listing.listingManifestHash
    || result.requestHash !== canonicalHash(request) || typeof result.signature !== "string"
    || !Number.isSafeInteger(result.issuedAt) || Number(result.issuedAt) > now + 30
    || Number(result.issuedAt) < now - 120 || !Number.isSafeInteger(result.validBefore)
    || Number(result.validBefore) <= now || Number(result.validBefore) > now + 120
    || !Array.isArray(result.selectorsRequired)
    || !result.selectorsRequired.every((entry) => typeof entry === "string")
    || !Array.isArray(result.fieldErrors) || result.fieldErrors.length > 32
    || !result.fieldErrors.every((entry) => entry && typeof entry === "object"
      && ["path", "rule", "message"].every((key) => typeof (entry as Record<string, unknown>)[key] === "string"))
    || ![true, false, null].includes(result.supported as boolean | null)) {
    throw new Error("Intake binding is invalid");
  }
  for (const key of ["requestSchema", "requiredFields", "normalizedSelectors"]) {
    if (!result[key] || typeof result[key] !== "object" || Array.isArray(result[key])) {
      throw new Error("Invalid intake contract");
    }
  }
  if (canonicalHash(result.requestSchema) !== canonicalHash(listing.requestSchema)) {
    throw new Error("Intake schema mismatch");
  }
  const { signature, ...payload } = result;
  const signer = await recoverMessageAddress({
    message: { raw: canonicalHash(payload) },
    signature: signature as Hex,
  });
  if (getAddress(signer) !== getAddress(listing.providerAuthorityKey)) {
    throw new Error("Invalid intake signer");
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Dispatch, status and operations (gateway src/standardRail/providerDispatch.ts,
// operationsSchema.ts and operationsStore.ts at 8f15201).


const time = z.number().int().nonnegative();
export const operationsSchema = z.object({
  schemaVersion: z.literal(1),
  revision: time,
  observedAt: time,
  fulfillment: z.unknown().nullable(),
  support: z.unknown().nullable(),
  recovery: z.unknown().nullable(),
}).strict().refine((value) =>
  value.fulfillment === null && value.support === null && value.recovery === null,
"lite publishes no operations sections");

interface TerminalPayload {
  taskId: string;
  dispatchHash: Hex;
  state: string;
  resultHash: Hex;
  completedAt: number;
}

const DISPATCH_STATES = [
  "dispatching", "submitted", "working", "input-required", "completed", "failed", "canceled",
];

/** Port of validateDispatchResponse + terminalEvidence + persistOperations' freshness. */
export async function acceptDispatchSnapshotAsGateway(args: {
  value: unknown;
  dispatchHash: Hex;
  providerAuthorityKey?: Address;
  providerTerminalAttestationKey?: Address;
  now?: number;
}) {
  const now = args.now ?? nowSeconds();
  const body = args.value as Record<string, unknown> & {
    terminalAttestation?: { payload?: Record<string, unknown>; signature?: unknown };
  };
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("malformed");
  const terminal = ["completed", "failed", "canceled"].includes(String(body.state));
  const expected = terminal
    ? "dispatchHash,operations,signature,state,taskId,terminalAttestation"
    : "dispatchHash,operations,signature,state,taskId";
  if (sortedKeys(body) !== expected) throw new Error("provider dispatch response fields are invalid");
  if (
    typeof body.taskId !== "string" || body.taskId.length === 0 || body.taskId.length > 128
    || body.dispatchHash !== args.dispatchHash || typeof body.signature !== "string"
    || !DISPATCH_STATES.includes(String(body.state))
  ) throw new Error("provider_dispatch_response_malformed");
  const operations = operationsSchema.parse(body.operations);
  const responseHash = canonicalHash({
    taskId: body.taskId,
    dispatchHash: args.dispatchHash,
    state: body.state,
    operations,
  });
  const signer = await recoverMessageAddress({ message: { raw: responseHash }, signature: body.signature as Hex });
  if (getAddress(signer) !== getAddress(args.providerAuthorityKey ?? providerAuthority)) {
    throw new Error("provider_dispatch_response_signature_invalid");
  }
  if (operations.observedAt > now + 30 || operations.observedAt < now - 300) {
    throw new Error("provider_operations_observation_stale");
  }
  if (!terminal) return { body, operations, attestation: null as TerminalPayload | null };
  const attestation = body.terminalAttestation!;
  if (!attestation?.payload || typeof attestation.signature !== "string"
    || sortedKeys(attestation) !== "payload,signature"
    || sortedKeys(attestation.payload) !== "completedAt,dispatchHash,resultHash,state,taskId") {
    throw new Error("provider_terminal_attestation_missing");
  }
  const completedAt = attestation.payload.completedAt;
  if (
    typeof completedAt !== "number" || !Number.isSafeInteger(completedAt) || completedAt <= 0
    || completedAt > now + 30 || typeof attestation.payload.resultHash !== "string"
    || !/^0x[0-9a-fA-F]{64}$/.test(attestation.payload.resultHash)
  ) throw new Error("provider_terminal_attestation_time_invalid");
  const terminalSigner = await recoverMessageAddress({
    message: { raw: canonicalHash(attestation.payload) },
    signature: attestation.signature as Hex,
  });
  if (
    getAddress(terminalSigner) !== getAddress(args.providerTerminalAttestationKey ?? providerAuthority)
    || attestation.payload.taskId !== body.taskId
    || attestation.payload.dispatchHash !== args.dispatchHash
    || attestation.payload.state !== body.state
  ) throw new Error("provider_terminal_attestation_invalid");
  return { body, operations, attestation: attestation.payload as unknown as TerminalPayload | null };
}

export interface ProviderAnswer {
  status: number;
  contentType: string | null;
  contentEncoding: string | null;
  text: string;
}

function boundedJson(answer: ProviderAnswer): unknown {
  const mediaType = answer.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json" || (answer.contentEncoding && answer.contentEncoding !== "identity")) {
    throw new Error("BOUNDED_JSON_MEDIA_TYPE_INVALID");
  }
  if (!answer.text) throw new Error("BOUNDED_JSON_EMPTY");
  return JSON.parse(answer.text);
}

/** How the gateway's dispatch() treats a provider answer to a dispatch POST. */
export function classifyDispatchAnswer(answer: ProviderAnswer): "accepted" | "refused" | "ambiguous" {
  let body: unknown;
  try {
    body = boundedJson(answer);
  } catch {
    return "ambiguous";
  }
  if (answer.status >= 200 && answer.status < 300) return "accepted";
  if (answer.status >= 400 && answer.status < 600 && body && typeof body === "object"
    && !Array.isArray(body) && "error" in body
    && (body as { error: unknown }).error !== null && (body as { error: unknown }).error !== undefined) {
    return "refused";
  }
  return "ambiguous";
}

/** How queryProviderDispatchStatus treats a status answer. */
export function classifyStatusAnswer(answer: ProviderAnswer): "snapshot" | "no_claim" | "unavailable" {
  if (answer.status >= 200 && answer.status < 300) return "snapshot";
  if (answer.status === 404) {
    try {
      const body = boundedJson(answer) as Record<string, unknown>;
      if (body && typeof body === "object" && !Array.isArray(body) && body.error != null
        && body.reason === "outcome_policy") return "no_claim";
    } catch {
      return "unavailable";
    }
  }
  return "unavailable";
}

/** The DispatchStatusQueryV1 the gateway signs for reconciliation. */
export function gatewayStatusQuery(orderId: string, dispatchHash: Hex, issuedAt = nowSeconds()) {
  return signGatewayEnvelope({
    artifactType: "DispatchStatusQueryV1",
    issuedAt,
    validBefore: issuedAt + 60,
    payload: { orderId, dispatchHash, issuedAt, validBefore: issuedAt + 60 },
  });
}

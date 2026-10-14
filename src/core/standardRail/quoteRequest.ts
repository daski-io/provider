import type { Hex } from "viem";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { GatewayEnvelopeError, verifyGatewayRequestEnvelope } from "./gatewayEnvelope.js";
import { assertBoundedJsonValue, REQUEST_JSON_BUDGET } from "./jsonBounds.js";
import { QuoteRefusal } from "./quoteErrors.js";
import type { ProviderOutcomeConfig, SignedEnvelope } from "./types.js";

type RequestKind = "quote" | "intake";

/** Authenticate a quote or intake envelope before reading any of its payload. */
export async function authenticateQuotedRequest<T>(args: {
  kind: RequestKind;
  value: unknown;
  artifactType: "ProviderQuoteRequestV1" | "ProviderIntakeRequestV1";
  payloadKeys: readonly string[];
  config: ProviderStandardRailConfig;
  chainId: number;
}): Promise<SignedEnvelope<T>> {
  try {
    return await verifyGatewayRequestEnvelope<T>(args.value, {
      artifactType: args.artifactType,
      payloadKeys: args.payloadKeys,
      environment: args.config.environment,
      chainId: args.chainId,
      audience: args.config.providerAudience,
      signer: args.config.gatewayDispatchSigner,
    });
  } catch (error) {
    const signature = error instanceof GatewayEnvelopeError && error.failure === "signature";
    throw new QuoteRefusal(args.kind, 401, signature ? "signature" : "envelope");
  }
}

/** The installed listing version the gateway asked about, by exact identity. */
export function resolveQuotedOutcome(
  kind: RequestKind,
  config: ProviderStandardRailConfig,
  outcomeId: unknown,
  listingManifestHash: unknown,
): ProviderOutcomeConfig {
  const outcome = [...config.outcomes.values()].find((candidate) =>
    candidate.outcomeId === outcomeId && candidate.listingManifestHash === listingManifestHash);
  if (!outcome) throw new QuoteRefusal(kind, 409, "outcome_policy");
  return outcome;
}

/** Bound the buyer request and bind it to the gateway's signed request hash. */
export function boundQuotedRequest(
  kind: RequestKind,
  request: unknown,
  requestHash: Hex,
): Record<string, unknown> {
  const invalid = (rule: string, message: string) =>
    new QuoteRefusal(kind, 422, "request_invalid", [{ path: "$", rule, message }]);
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw invalid("type", "Request must be a JSON object.");
  }
  try {
    assertBoundedJsonValue(request, REQUEST_JSON_BUDGET, "Request");
  } catch {
    throw invalid("json-bounds", "Request exceeds the bounded JSON contract.");
  }
  let actual: Hex;
  try {
    actual = canonicalHash(request);
  } catch {
    throw invalid("canonical-json", "Request is not canonical JSON.");
  }
  if (actual !== requestHash) throw new QuoteRefusal(kind, 409, "binding");
  return request as Record<string, unknown>;
}

import type { ValidateFunction } from "ajv";
import type { Hex } from "viem";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { assertBoundedJsonValue, RESPONSE_JSON_BUDGET } from "./jsonBounds.js";
import { schemaFieldErrors } from "./quoteFieldErrors.js";
import {
  authenticateQuotedRequest,
  boundQuotedRequest,
  resolveQuotedOutcome,
} from "./quoteRequest.js";

const INTAKE_PAYLOAD_KEYS = ["outcomeId", "listingManifestHash", "requestHash", "request"] as const;
const INTAKE_LIFETIME_SECONDS = 60;

interface ProviderIntakeRequestV1 {
  outcomeId: string;
  listingManifestHash: Hex;
  requestHash: Hex;
  request: unknown;
}

/**
 * Signed intake discovery on the admitted quote URL. Lite services declare no
 * contextual intake, so the answer is the published schema, the field errors
 * of the partial request against it, and `supported: null` (availability not
 * determined). It creates no quote, draft, or task.
 */
export async function describeIntake(args: {
  value: unknown;
  config: ProviderStandardRailConfig;
  chainId: number;
  validator(listingManifestHash: Hex): ValidateFunction;
  sign(digest: Hex): Promise<Hex>;
}): Promise<Record<string, unknown>> {
  const envelope = await authenticateQuotedRequest<ProviderIntakeRequestV1>({
    kind: "intake",
    value: args.value,
    artifactType: "ProviderIntakeRequestV1",
    payloadKeys: INTAKE_PAYLOAD_KEYS,
    config: args.config,
    chainId: args.chainId,
  });
  const query = envelope.payload;
  const outcome = resolveQuotedOutcome(
    "intake", args.config, query.outcomeId, query.listingManifestHash,
  );
  const request = boundQuotedRequest("intake", query.request, query.requestHash);
  const validate = args.validator(outcome.listingManifestHash);
  const fieldErrors = validate(request) ? [] : schemaFieldErrors(validate.errors);
  const issuedAt = Math.floor(Date.now() / 1_000);
  const payload = {
    outcomeId: query.outcomeId,
    listingManifestHash: query.listingManifestHash,
    requestHash: query.requestHash,
    requestSchema: outcome.requestSchema,
    requiredFields: {},
    selectorsRequired: [],
    normalizedSelectors: {},
    fieldErrors,
    supported: null,
    issuedAt,
    validBefore: issuedAt + INTAKE_LIFETIME_SECONDS,
  };
  assertBoundedJsonValue(payload, RESPONSE_JSON_BUDGET, "Intake response");
  return { ...payload, signature: await args.sign(canonicalHash(payload)) };
}

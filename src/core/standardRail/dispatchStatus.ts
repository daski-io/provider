import type { ProviderStandardRailConfig } from "./config.js";
import { HASH32_PATTERN as HASH32, ORDER_ID_PATTERN as ORDER_ID } from "./dispatchContract.js";
import {
  DispatchAmbiguousError,
  DispatchStatusNoClaimError,
  DispatchStatusRejectedError,
} from "./dispatchErrors.js";
import {
  signDispatchSnapshot,
  type DispatchSnapshot,
  type ProviderResponseSigner,
} from "./dispatchResponse.js";
import { GatewayEnvelopeError, verifyGatewayRequestEnvelope } from "./gatewayEnvelope.js";
import { dispatchHashOf, findTransaction } from "./transactionStore.js";
import type { DispatchStatusQueryV1 } from "./types.js";

/**
 * Answer a gateway reconciliation query with one indexed read: no product
 * call, no write, and a fresh database-clock observation re-signed per call.
 * The signature and freshness are verified before any claim is looked up or
 * revealed. Only a verified query whose authoritative lookup finds no claim
 * for (gateway audience, order) yields the no-claim answer; every other
 * failure proves nothing about absence.
 */
export async function answerDispatchStatus(
  body: unknown,
  context: { config: ProviderStandardRailConfig; chainId: number; signer: ProviderResponseSigner },
): Promise<DispatchSnapshot> {
  const record = body as Record<string, unknown> | null;
  if (
    !record || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).join() !== "query"
  ) throw new DispatchStatusRejectedError("query_invalid", false);
  let query: DispatchStatusQueryV1;
  try {
    const envelope = await verifyGatewayRequestEnvelope<DispatchStatusQueryV1>(record.query, {
      artifactType: "DispatchStatusQueryV1",
      payloadKeys: ["orderId", "dispatchHash", "issuedAt", "validBefore"],
      environment: context.config.environment,
      chainId: context.chainId,
      audience: context.config.providerAudience,
      signer: context.config.gatewayDispatchSigner,
    });
    query = envelope.payload;
    if (
      envelope.issuedAt !== query.issuedAt || envelope.validBefore !== query.validBefore
      || typeof query.orderId !== "string" || !ORDER_ID.test(query.orderId)
      || typeof query.dispatchHash !== "string" || !HASH32.test(query.dispatchHash)
    ) throw new DispatchStatusRejectedError("query_invalid", true);
  } catch (error) {
    if (error instanceof DispatchStatusRejectedError) throw error;
    const signature = error instanceof GatewayEnvelopeError && error.failure === "signature";
    throw new DispatchStatusRejectedError(signature ? "signature" : "query_invalid", false);
  }
  let claim;
  try {
    claim = await findTransaction(context.config.gatewayAudience, query.orderId);
  } catch (error) {
    throw new DispatchAmbiguousError("Dispatch status lookup failed", error);
  }
  if (!claim) throw new DispatchStatusNoClaimError();
  if (dispatchHashOf(claim) !== query.dispatchHash.toLowerCase()) {
    throw new DispatchStatusRejectedError("binding_conflict", true);
  }
  try {
    return await signDispatchSnapshot(claim, query.dispatchHash, context.signer);
  } catch (error) {
    throw new DispatchAmbiguousError("Dispatch status could not be signed", error);
  }
}

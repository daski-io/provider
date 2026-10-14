import { getAddress, type Hex } from "viem";
import { assertExactKeys, canonicalHash, SIGNED_ENVELOPE_KEYS } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { HASH32_PATTERN as HASH32 } from "./dispatchContract.js";
import { DispatchRejectedError } from "./dispatchErrors.js";
import { gatewayEnvelopeSigner } from "./gatewayEnvelope.js";
import { assertFixedQuotePolicy } from "./paymentBinding.js";
import type { ProviderQuotePayload } from "./quoteStore.js";
import type {
  ProviderOutcomeConfig,
  QuoteV1,
  SignedEnvelope,
  StandardRailDispatchV2,
} from "./types.js";

const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const QUOTE_PAYLOAD_KEYS = [
  "listingManifestHash", "providerOfferHash", "providerQuoteHash", "canonicalRequestHash",
  "grossAmount", "token", "splitter", "orderNonce", "issuedAt", "validBefore",
] as const;
const nowSeconds = () => Math.floor(Date.now() / 1_000);

/**
 * Verify the forwarded gateway QuoteV1. It may have expired long ago: a
 * timely-paid order can be dispatched freshly until the gateway's recovery
 * horizon, so no quote age is enforced here. Settlement timeliness is proven
 * by the deposit block timestamp during evidence verification.
 */
export async function verifyQuoteEnvelope(
  envelope: SignedEnvelope<QuoteV1>,
  dispatch: StandardRailDispatchV2,
  outcome: ProviderOutcomeConfig,
  config: ProviderStandardRailConfig,
  chainId: number,
): Promise<void> {
  try {
    assertExactKeys(envelope, SIGNED_ENVELOPE_KEYS, "quote envelope");
    assertExactKeys(envelope.payload, QUOTE_PAYLOAD_KEYS, "quote payload");
  } catch {
    throw new DispatchRejectedError("quote_window");
  }
  if (
    envelope.artifactType !== "QuoteV1"
    || envelope.schemaVersion !== 1
    || envelope.environment !== config.environment
    || envelope.chainId !== chainId
    || envelope.audience !== config.gatewayAudience
    || envelope.signerKeyId !== "gateway-quote"
    || envelope.issuedAt !== envelope.payload.issuedAt
    || envelope.validBefore !== envelope.payload.validBefore
    || !Number.isSafeInteger(envelope.issuedAt)
    || !Number.isSafeInteger(envelope.validBefore)
    || envelope.issuedAt > nowSeconds() + 30
    || envelope.validBefore <= envelope.issuedAt
    || canonicalHash(envelope) !== dispatch.quoteHash
  ) throw new DispatchRejectedError("quote_window");
  let signer: Hex;
  try {
    signer = await gatewayEnvelopeSigner(envelope);
  } catch {
    throw new DispatchRejectedError("signature");
  }
  if (signer !== config.gatewayQuoteSigner) throw new DispatchRejectedError("signature");
  const quote = envelope.payload;
  if (
    quote.listingManifestHash !== dispatch.listingManifestHash
    || quote.providerOfferHash !== dispatch.providerOfferHash
    || typeof quote.providerQuoteHash !== "string" || !HASH32.test(quote.providerQuoteHash)
    || quote.providerQuoteHash.toLowerCase() === ZERO_BYTES32
    || quote.canonicalRequestHash !== dispatch.canonicalRequestHash
    || quote.orderNonce !== dispatch.orderNonce
    || !/^0x[0-9a-fA-F]{40}$/.test(quote.token) || !/^0x[0-9a-fA-F]{40}$/.test(quote.splitter)
    || getAddress(quote.token) !== getAddress(outcome.token)
    || getAddress(quote.splitter) !== getAddress(outcome.splitter)
  ) throw new DispatchRejectedError("quote_window");
  if (quote.grossAmount !== dispatch.grossAmount) throw new DispatchRejectedError("price");
  assertFixedQuotePolicy(outcome);
}

/**
 * Bind the persisted provider quote named by QuoteV1 to this dispatch. The
 * quote payer was echoed in lowercase; the dispatch payer is checksummed, so
 * they are compared as addresses. The provider window must cover the gateway
 * window; neither is compared to the current time.
 */
export function assertProviderQuoteBinding(
  providerQuote: ProviderQuotePayload | null,
  quote: SignedEnvelope<QuoteV1>,
  dispatch: StandardRailDispatchV2,
  outcome: ProviderOutcomeConfig,
): void {
  if (
    !providerQuote
    || providerQuote.outcomeId !== outcome.outcomeId
    || providerQuote.listingManifestHash !== dispatch.listingManifestHash.toLowerCase()
    || providerQuote.requestHash !== dispatch.canonicalProviderRequestHash.toLowerCase()
    || (providerQuote.payer !== null
      && getAddress(providerQuote.payer) !== getAddress(dispatch.payer))
    || providerQuote.issuedAt > quote.issuedAt
    || quote.validBefore > providerQuote.validBefore
  ) throw new DispatchRejectedError("quote_window");
  if (
    providerQuote.grossAmount !== dispatch.grossAmount
    || providerQuote.grossAmount !== outcome.fixedGrossAmount
  ) throw new DispatchRejectedError("price");
}

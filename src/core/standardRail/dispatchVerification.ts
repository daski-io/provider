import { getAddress, keccak256, stringToHex, type Hex } from "viem";
import { assertExactKeys, canonicalHash, SIGNED_ENVELOPE_KEYS } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { STANDARD_DISPATCH_PAYLOAD_KEYS } from "./dispatchContract.js";
import { DispatchRejectedError } from "./dispatchErrors.js";
import { GATEWAY_DISPATCH_KEY_ID, gatewayEnvelopeSigner } from "./gatewayEnvelope.js";
import { assertFixedQuotePolicy } from "./paymentBinding.js";
import type { ProviderQuotePayload } from "./quoteStore.js";
import type {
  ProviderOutcomeConfig,
  QuoteV1,
  SignedEnvelope,
  StandardRailDispatchV2,
} from "./types.js";

const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const HASH32 = /^0x[0-9a-fA-F]{64}$/;
const ORDER_ID = /^ord_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const QUOTE_PAYLOAD_KEYS = [
  "listingManifestHash", "providerOfferHash", "providerQuoteHash", "canonicalRequestHash",
  "grossAmount", "token", "splitter", "orderNonce", "issuedAt", "validBefore",
] as const;
const nowSeconds = () => Math.floor(Date.now() / 1_000);
const unauthenticated = (reason: "signature" | "envelope_lifetime" | "validator") =>
  new DispatchRejectedError(reason, false);

/**
 * Authenticate a dispatch envelope and the claim key it names. Expiry is not
 * checked here, and neither are the remaining payload bindings: an
 * authenticated exact replay of admitted work must still be answered after
 * validBefore, and its dispatch hash already pins every signed field.
 */
export async function authenticateDispatchEnvelope(
  envelope: SignedEnvelope<StandardRailDispatchV2, 2>,
  config: ProviderStandardRailConfig,
  chainId: number,
): Promise<void> {
  try {
    assertExactKeys(envelope, SIGNED_ENVELOPE_KEYS, "dispatch envelope");
    assertExactKeys(envelope.payload, STANDARD_DISPATCH_PAYLOAD_KEYS, "dispatch payload");
  } catch {
    throw unauthenticated("validator");
  }
  if (
    envelope.artifactType !== "StandardRailDispatchV2"
    || envelope.schemaVersion !== 2
    || envelope.environment !== config.environment
    || envelope.chainId !== chainId
    || envelope.audience !== config.providerAudience
    || envelope.signerKeyId !== GATEWAY_DISPATCH_KEY_ID
    || !Number.isSafeInteger(envelope.issuedAt)
    || !Number.isSafeInteger(envelope.validBefore)
    || envelope.issuedAt > nowSeconds() + 30
  ) throw unauthenticated("envelope_lifetime");
  let signer: Hex;
  try {
    signer = await gatewayEnvelopeSigner(envelope);
  } catch {
    throw unauthenticated("signature");
  }
  if (signer !== config.gatewayDispatchSigner) throw unauthenticated("signature");
  const dispatch = envelope.payload;
  if (
    dispatch.gatewayAudience !== config.gatewayAudience
    || typeof dispatch.orderId !== "string" || !ORDER_ID.test(dispatch.orderId)
    || dispatch.issuedAt !== envelope.issuedAt
    || dispatch.validBefore !== envelope.validBefore
  ) throw new DispatchRejectedError("validator");
}

/** Every static payload binding a new claim needs. */
export function assertDispatchPayloadBound(
  envelope: SignedEnvelope<StandardRailDispatchV2, 2>,
  request: Record<string, unknown>,
  config: ProviderStandardRailConfig,
  chainId: number,
): void {
  let bound = false;
  try {
    bound = dispatchPayloadIsBound(envelope, request, config, chainId);
  } catch {
    bound = false;
  }
  if (!bound) throw new DispatchRejectedError("validator");
}

function dispatchPayloadIsBound(
  envelope: SignedEnvelope<StandardRailDispatchV2, 2>,
  request: Record<string, unknown>,
  config: ProviderStandardRailConfig,
  chainId: number,
): boolean {
  const dispatch = envelope.payload;
  const hashes = [
    dispatch.providerControlProfileHash, dispatch.dispatchNonce, dispatch.listingManifestHash,
    dispatch.orderKey, dispatch.serviceId, dispatch.outcomeSchemaUid, dispatch.providerOfferHash,
    dispatch.quoteHash, dispatch.canonicalRequestHash, dispatch.orderNonce,
    dispatch.buyerIdentityProofHash, dispatch.activeRailProfileHash,
    dispatch.facilitatorConfirmationHash, dispatch.settlementTxHash, dispatch.depositBlockHash,
    dispatch.depositEvidenceHash, dispatch.releaseTxHash, dispatch.releaseBlockHash,
    dispatch.releaseEvidenceHash, dispatch.canonicalProviderRequestHash,
  ];
  const unsigned = /^(0|[1-9]\d*)$/;
  const depositBlock = unsigned.test(dispatch.depositBlockNumber)
    ? BigInt(dispatch.depositBlockNumber) : -1n;
  const releaseBlock = unsigned.test(dispatch.releaseBlockNumber)
    ? BigInt(dispatch.releaseBlockNumber) : -1n;
  const releaseAfterDeposit = releaseBlock > depositBlock
    || (releaseBlock === depositBlock
      && dispatch.releaseTransactionIndex > dispatch.depositTransactionIndex)
    || (releaseBlock === depositBlock
      && dispatch.releaseTransactionIndex === dispatch.depositTransactionIndex
      && dispatch.releaseLogIndex > dispatch.depositLogIndex);
  const indexes = [
    dispatch.depositTransactionIndex, dispatch.depositLogIndex,
    dispatch.releaseTransactionIndex, dispatch.releaseLogIndex,
  ];
  return dispatch.environment === config.environment
    && dispatch.chainId === chainId
    && dispatch.gatewayAudience === config.gatewayAudience
    && dispatch.providerAudience === config.providerAudience
    && dispatch.reputationEligible === true
    && /^0x[0-9a-fA-F]{40}$/.test(dispatch.reputationContract)
    && getAddress(dispatch.reputationContract) === config.reputationContract
    && dispatch.outcomeSchemaUid === config.reputationOutcomeSchemaUid
    && dispatch.issuedAt === envelope.issuedAt
    && dispatch.validBefore === envelope.validBefore
    && dispatch.canonicalProviderRequestHash === canonicalHash(request)
    && /^0x[0-9a-fA-F]{40}$/.test(dispatch.payer)
    && typeof dispatch.orderId === "string" && ORDER_ID.test(dispatch.orderId)
    && dispatch.orderKey === keccak256(stringToHex(dispatch.orderId))
    && hashes.every((hash) => typeof hash === "string" && HASH32.test(hash))
    && dispatch.facilitatorConfirmationHash.toLowerCase() !== ZERO_BYTES32
    && depositBlock >= 0n && releaseBlock >= 0n
    && indexes.every((index) => Number.isSafeInteger(index) && index >= 0)
    && /^[1-9]\d*$/.test(dispatch.releaseSequence) && BigInt(dispatch.releaseSequence) < 1n << 64n
    && releaseAfterDeposit
    && !(depositBlock === releaseBlock
      && dispatch.depositBlockHash.toLowerCase() !== dispatch.releaseBlockHash.toLowerCase())
    && !(depositBlock === releaseBlock
      && dispatch.depositTransactionIndex === dispatch.releaseTransactionIndex
      && dispatch.settlementTxHash.toLowerCase() !== dispatch.releaseTxHash.toLowerCase())
    && [dispatch.grossAmount, dispatch.providerNetAmount, dispatch.daskiCommissionAmount]
      .every((amount) => typeof amount === "string" && /^[1-9]\d*$/.test(amount))
    && BigInt(dispatch.providerNetAmount) + BigInt(dispatch.daskiCommissionAmount)
      === BigInt(dispatch.grossAmount)
    && Number.isSafeInteger(dispatch.dispatchDeadlineSeconds)
    && dispatch.dispatchDeadlineSeconds >= 30;
}

/** A new claim needs a current envelope with the listing's exact lifetime. */
export function assertDispatchIsCurrent(
  envelope: SignedEnvelope<StandardRailDispatchV2, 2>,
  outcome: ProviderOutcomeConfig,
): void {
  if (
    envelope.validBefore <= nowSeconds()
    || envelope.payload.dispatchDeadlineSeconds !== outcome.dispatchDeadlineSeconds
    || envelope.validBefore !== envelope.issuedAt + outcome.dispatchDeadlineSeconds
  ) throw new DispatchRejectedError("envelope_lifetime");
}

export function assertOutcomeBinding(
  dispatch: StandardRailDispatchV2,
  outcome: ProviderOutcomeConfig,
  config: ProviderStandardRailConfig,
): void {
  if (
    outcome.providerControlProfileHash !== dispatch.providerControlProfileHash
    || outcome.serviceId !== dispatch.serviceId
    || outcome.activeRailProfileHash !== dispatch.activeRailProfileHash
    || dispatch.buyerIdentityProofHash.toLowerCase() !== ZERO_BYTES32
    || outcome.bindingProfile !== dispatch.bindingProfile
  ) throw new DispatchRejectedError("outcome_policy");
  const forbidden = [
    config.providerAuthorityKey, config.terminalAttestationKey, outcome.providerPayee,
    outcome.daskiCommissionReceiver, outcome.splitter, ...outcome.providerControlledWallets,
  ].map((address) => getAddress(address).toLowerCase());
  if (forbidden.includes(getAddress(dispatch.payer).toLowerCase())) {
    throw new DispatchRejectedError("self_purchase");
  }
}

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

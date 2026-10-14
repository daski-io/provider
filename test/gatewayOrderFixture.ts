import { randomBytes, randomUUID } from "node:crypto";
import { getAddress, keccak256, stringToHex, type Hex } from "viem";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import { assertDepositWithinQuoteWindow } from "../src/core/standardRail/paymentBinding.js";
import type { StandardQuoteService } from "../src/core/standardRail/quote.js";
import type {
  ProviderOutcomeConfig,
  QuoteV1,
  SignedEnvelope,
  StandardRailDispatchV2,
} from "../src/core/standardRail/types.js";
import { acceptQuoteAsGateway, gatewayQuoteRequest, nowSeconds, signGatewayEnvelope } from "./gatewayWire.js";
import { gatewayListing } from "./standardRailServiceFixture.js";

const random32 = () => `0x${randomBytes(32).toString("hex")}` as Hex;

/**
 * Chain evidence stand-in: the RPC proof is out of scope offline, but the
 * settlement-time rule is the real one, judged by the deposit block
 * timestamp the test chooses for each order.
 */
export class FakeEvidence {
  readonly depositTimestamps = new Map<string, number>();
  verified = 0;

  async verify(args: { dispatch: StandardRailDispatchV2; quote: SignedEnvelope<QuoteV1> }) {
    this.verified += 1;
    const timestamp = this.depositTimestamps.get(args.dispatch.orderId) ?? args.quote.issuedAt + 5;
    assertDepositWithinQuoteWindow(timestamp, args.quote);
    return { authorizationKey: keccak256(stringToHex(`authorization:${args.dispatch.orderId}`)) };
  }

  async assertNotSanctioned(): Promise<void> {}
}

export interface GatewayOrder {
  orderId: string;
  request: Record<string, unknown>;
  payer: Hex;
  quote: SignedEnvelope<QuoteV1>;
  providerQuoteHash: Hex;
  orderNonce: Hex;
  position: number;
}

let positions = 0;

/** Readiness quote, then the gateway's QuoteV1 for that provider quote (issueChallenge). */
export async function quoteOrder(args: {
  quotes: StandardQuoteService;
  outcome: ProviderOutcomeConfig;
  request?: Record<string, unknown>;
  payer?: Hex;
  quotePayer?: Hex | null;
  challengeTtlSeconds?: number;
  /** The provider key the gateway's listing names when the quote is priced. */
  providerAuthorityKey?: Hex;
}): Promise<GatewayOrder> {
  const listing = {
    ...gatewayListing(args.outcome),
    ...(args.providerAuthorityKey ? { providerAuthorityKey: args.providerAuthorityKey } : {}),
  };
  const request = args.request ?? { message: "hello" };
  const payer = getAddress(args.payer ?? `0x${randomBytes(20).toString("hex")}` as Hex);
  const quotePayer = args.quotePayer === undefined ? payer.toLowerCase() as Hex : args.quotePayer;
  const body = await args.quotes.quote(await gatewayQuoteRequest({ listing, request, payer: quotePayer }));
  const priced = await acceptQuoteAsGateway({ listing, body, request, payer: quotePayer });
  const now = nowSeconds();
  const expiresAt = Math.min(now + (args.challengeTtlSeconds ?? 300), now + 300, priced.validBefore);
  const orderNonce = random32();
  const quote = await signGatewayEnvelope<QuoteV1>({
    artifactType: "QuoteV1",
    audience: "https://gateway.example",
    signerKeyId: "gateway-quote",
    issuedAt: priced.issuedAt,
    validBefore: expiresAt,
    payload: {
      listingManifestHash: args.outcome.listingManifestHash,
      providerOfferHash: args.outcome.providerOfferHash,
      providerQuoteHash: priced.providerQuoteHash,
      canonicalRequestHash: canonicalHash({
        method: "POST",
        resource: `https://gateway.example/outcomes/1/${args.outcome.outcomeId}`,
        providerAgentId: "1",
        outcomeId: args.outcome.outcomeId,
        body: request,
      }),
      grossAmount: priced.grossAmount,
      token: args.outcome.token,
      splitter: args.outcome.splitter,
      orderNonce,
      issuedAt: priced.issuedAt,
      validBefore: expiresAt,
    },
  });
  positions += 1;
  return {
    orderId: `ord_${randomUUID()}`,
    request,
    payer,
    quote,
    providerQuoteHash: priced.providerQuoteHash,
    orderNonce,
    position: positions,
  };
}

/** A fresh signed dispatch for a paid order, built as the gateway's buildPayload does. */
export async function dispatchOrder(args: {
  order: GatewayOrder;
  outcome: ProviderOutcomeConfig;
  config: ProviderStandardRailConfig;
  issuedAt?: number;
  quote?: SignedEnvelope<QuoteV1>;
  request?: Record<string, unknown>;
}): Promise<{ body: Record<string, unknown>; dispatchHash: Hex; envelope: SignedEnvelope<StandardRailDispatchV2, 2> }> {
  const { order, outcome, config } = args;
  const quote = args.quote ?? order.quote;
  const request = args.request ?? order.request;
  const issuedAt = args.issuedAt ?? nowSeconds();
  const depositBlock = 10_000 + order.position * 10;
  const depositEvidence = { kind: "deposit", orderId: order.orderId };
  const releaseEvidence = { kind: "release", orderId: order.orderId };
  const deposit = {
    transactionHash: random32(),
    blockNumber: String(depositBlock),
    blockHash: random32(),
    transactionIndex: 2,
    logIndex: 3,
    evidenceHash: canonicalHash(depositEvidence),
    canonicalEvidence: depositEvidence,
    sources: ["rpc-a", "rpc-b"],
  };
  const release = {
    transactionHash: random32(),
    blockNumber: String(depositBlock + 1),
    blockHash: random32(),
    transactionIndex: 4,
    logIndex: 5,
    releaseSequence: "8",
    evidenceHash: canonicalHash(releaseEvidence),
    canonicalEvidence: releaseEvidence,
    sources: ["rpc-a", "rpc-b"],
  };
  const payload: StandardRailDispatchV2 = {
    environment: config.environment,
    chainId: config.chainId,
    gatewayAudience: config.gatewayAudience,
    providerAudience: config.providerAudience,
    providerControlProfileHash: outcome.providerControlProfileHash,
    orderId: order.orderId,
    orderKey: keccak256(stringToHex(order.orderId)),
    serviceId: outcome.serviceId,
    reputationEligible: true,
    reputationContract: config.reputationContract,
    outcomeSchemaUid: config.reputationOutcomeSchemaUid,
    dispatchNonce: random32(),
    payer: order.payer,
    listingManifestHash: outcome.listingManifestHash,
    providerOfferHash: outcome.providerOfferHash,
    quoteHash: canonicalHash(quote),
    bindingProfile: outcome.bindingProfile,
    canonicalRequestHash: quote.payload.canonicalRequestHash,
    orderNonce: order.orderNonce,
    buyerIdentityProofHash: `0x${"00".repeat(32)}`,
    activeRailProfileHash: outcome.activeRailProfileHash,
    facilitatorConfirmationHash: random32(),
    settlementTxHash: deposit.transactionHash,
    depositEvidenceHash: deposit.evidenceHash,
    depositBlockNumber: deposit.blockNumber,
    depositBlockHash: deposit.blockHash,
    depositTransactionIndex: deposit.transactionIndex,
    depositLogIndex: deposit.logIndex,
    releaseTxHash: release.transactionHash,
    releaseEvidenceHash: release.evidenceHash,
    releaseBlockNumber: release.blockNumber,
    releaseBlockHash: release.blockHash,
    releaseTransactionIndex: release.transactionIndex,
    releaseLogIndex: release.logIndex,
    releaseSequence: release.releaseSequence,
    grossAmount: quote.payload.grossAmount,
    providerNetAmount: String(BigInt(quote.payload.grossAmount) * 95n / 100n),
    daskiCommissionAmount: String(
      BigInt(quote.payload.grossAmount) - BigInt(quote.payload.grossAmount) * 95n / 100n,
    ),
    canonicalProviderRequestHash: canonicalHash(request),
    dispatchDeadlineSeconds: outcome.dispatchDeadlineSeconds,
    issuedAt,
    validBefore: issuedAt + outcome.dispatchDeadlineSeconds,
  };
  const envelope = await signGatewayEnvelope<StandardRailDispatchV2, 2>({
    artifactType: "StandardRailDispatchV2",
    schemaVersion: 2,
    issuedAt,
    validBefore: payload.validBefore,
    payload,
  });
  return {
    body: { dispatch: envelope, quote, request, evidenceBundle: { deposit, release } },
    dispatchHash: canonicalHash(envelope),
    envelope,
  };
}

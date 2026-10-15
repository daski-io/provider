import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import {
  MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS,
  STANDARD_DISPATCH_PAYLOAD_KEYS,
} from "../src/core/standardRail/dispatchContract.js";
import { DispatchRejectedError } from "../src/core/standardRail/dispatchErrors.js";
import { verifyQuoteEnvelope } from "../src/core/standardRail/quoteBinding.js";
import type { QuoteV1, StandardRailDispatchV2 } from "../src/core/standardRail/types.js";
import { nowSeconds, signGatewayEnvelope } from "./gatewayWire.js";
import { railConfig, railOutcome } from "./standardRailServiceFixture.js";

describe("standard dispatch contract", () => {
  it("uses the canonical buyer identity proof field", () => {
    expect(STANDARD_DISPATCH_PAYLOAD_KEYS).toContain("buyerIdentityProofHash");
    expect(STANDARD_DISPATCH_PAYLOAD_KEYS).not.toContain("customerIdentityProofHash");
  });

  it("binds the exact V2 deposit and release coordinates", () => {
    expect(STANDARD_DISPATCH_PAYLOAD_KEYS).toEqual(expect.arrayContaining([
      "settlementTxHash",
      "depositBlockNumber",
      "depositBlockHash",
      "depositTransactionIndex",
      "depositLogIndex",
      "depositEvidenceHash",
      "releaseTxHash",
      "releaseBlockNumber",
      "releaseBlockHash",
      "releaseTransactionIndex",
      "releaseLogIndex",
      "releaseSequence",
      "releaseEvidenceHash",
    ]));
    expect(new Set(STANDARD_DISPATCH_PAYLOAD_KEYS).size)
      .toBe(STANDARD_DISPATCH_PAYLOAD_KEYS.length);
  });
});

describe("first-dispatch quote age bound", () => {
  const outcome = railOutcome();
  const config = railConfig([outcome]);
  const hash = (byte: string) => `0x${byte.repeat(32)}` as Hex;

  /** A gateway QuoteV1 that expired 30 days ago, and a new dispatch of its order issued at `issuedAt`. */
  async function order(issuedAt: (quoteValidBefore: number) => number) {
    const quoteIssuedAt = nowSeconds() - MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS - 120;
    const payload: QuoteV1 = {
      listingManifestHash: outcome.listingManifestHash,
      providerOfferHash: outcome.providerOfferHash,
      providerQuoteHash: hash("ab"),
      canonicalRequestHash: hash("cd"),
      grossAmount: outcome.fixedGrossAmount,
      token: outcome.token,
      splitter: outcome.splitter,
      orderNonce: hash("ef"),
      issuedAt: quoteIssuedAt,
      validBefore: quoteIssuedAt + 120,
    };
    const quote = await signGatewayEnvelope<QuoteV1>({
      artifactType: "QuoteV1", audience: config.gatewayAudience, signerKeyId: "gateway-quote",
      issuedAt: payload.issuedAt, validBefore: payload.validBefore, payload,
    });
    const dispatch = {
      listingManifestHash: outcome.listingManifestHash,
      providerOfferHash: outcome.providerOfferHash,
      quoteHash: canonicalHash(quote),
      canonicalRequestHash: payload.canonicalRequestHash,
      orderNonce: payload.orderNonce,
      grossAmount: payload.grossAmount,
      issuedAt: issuedAt(payload.validBefore),
    } as StandardRailDispatchV2;
    return { quote, dispatch };
  }

  it("is 30 days after the forwarded QuoteV1's validBefore", () => {
    expect(MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS).toBe(2_592_000);
  });

  it("admits a dispatch issued at the bound and refuses one issued after it as quote_window", async () => {
    const atBound = await order((validBefore) => validBefore + MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS);
    await expect(verifyQuoteEnvelope(atBound.quote, atBound.dispatch, outcome, config, 84532)).resolves.toBeUndefined();
    const late = await order((validBefore) => validBefore + MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS + 1);
    const refused = await verifyQuoteEnvelope(late.quote, late.dispatch, outcome, config, 84532)
      .then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(DispatchRejectedError);
    expect(refused).toMatchObject({ reason: "quote_window", authenticated: true });
  });
});

import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  assertDepositWithinQuoteWindow,
  assertDispatchWithinQuoteSettlementWindow,
  assertFixedQuotePolicy,
  selectDepositAuthorization,
} from "../src/core/standardRail/paymentBinding.js";

const nonce = (byte: string) => `0x${byte.repeat(64)}` as Hex;

function authorization(logIndex: number, usedNonce: Hex = nonce("a")) {
  return { logIndex, args: { nonce: usedNonce } };
}

describe("deposit authorization binding", () => {
  it("accepts only the authorization immediately before the settlement transfer", () => {
    const bound = authorization(6);
    expect(selectDepositAuthorization([bound], {
      depositLogIndex: 7,
      expectedNonce: null,
    })).toBe(bound);
  });

  it("rejects an unrelated authorization next to an allowance transfer", () => {
    expect(() => selectDepositAuthorization([authorization(2)], {
      depositLogIndex: 7,
      expectedNonce: null,
    })).toThrow("Deposit authorization does not bind the settlement transfer");
  });

  it("stays unambiguous with several payer authorizations", () => {
    const bound = authorization(6, nonce("b"));
    expect(selectDepositAuthorization([authorization(2), bound, authorization(9)], {
      depositLogIndex: 7,
      expectedNonce: null,
    })).toBe(bound);
  });

  it("requires the recipe-bound nonce at the bound position", () => {
    expect(() => selectDepositAuthorization([authorization(6, nonce("b"))], {
      depositLogIndex: 7,
      expectedNonce: nonce("c"),
    })).toThrow("Deposit authorization does not bind the settlement transfer");
    expect(selectDepositAuthorization([authorization(6, nonce("c"))], {
      depositLogIndex: 7,
      expectedNonce: nonce("c"),
    }).args.nonce).toBe(nonce("c"));
  });

  it("rejects a transfer at log zero and an event without a nonce", () => {
    expect(() => selectDepositAuthorization([authorization(0)], {
      depositLogIndex: 0,
      expectedNonce: null,
    })).toThrow("Deposit authorization does not bind the settlement transfer");
    expect(() => selectDepositAuthorization([{ logIndex: 6, args: {} }], {
      depositLogIndex: 7,
      expectedNonce: null,
    })).toThrow("Deposit authorization does not bind the settlement transfer");
  });
});

describe("deposit settlement window", () => {
  const quote = { issuedAt: 1_000, validBefore: 1_120 };

  it("accepts deposits inside the window and thirty seconds of clock skew", () => {
    expect(() => assertDepositWithinQuoteWindow(1_050, quote)).not.toThrow();
    expect(() => assertDepositWithinQuoteWindow(1_120, quote)).not.toThrow();
    expect(() => assertDepositWithinQuoteWindow(970, quote)).not.toThrow();
  });

  it("rejects stale, too-early, and unusable timestamps", () => {
    for (const timestamp of [969, 1_121, 0, Number.NaN]) {
      expect(() => assertDepositWithinQuoteWindow(timestamp, quote))
        .toThrow("outside the quote payment window");
    }
  });
});

describe("fixed quote policy", () => {
  it("accepts only fixed pricing with zero dynamic-window bounds", () => {
    expect(() => assertFixedQuotePolicy({
      pricingMode: "fixed",
      quoteMaximumLifetimeSeconds: 0,
      quoteMinimumPaymentWindowSeconds: 0,
    })).not.toThrow();
    expect(() => assertFixedQuotePolicy({
      pricingMode: "dynamic",
      quoteMaximumLifetimeSeconds: 120,
      quoteMinimumPaymentWindowSeconds: 30,
    })).toThrow("fixed one-shot quote policy");
    expect(() => assertFixedQuotePolicy({
      pricingMode: "fixed",
      quoteMaximumLifetimeSeconds: 1,
      quoteMinimumPaymentWindowSeconds: 0,
    })).toThrow("fixed one-shot quote policy");
  });
});

describe("dispatch settlement lateness", () => {
  it("allows one dispatch deadline after the payment window", () => {
    expect(() => assertDispatchWithinQuoteSettlementWindow(
      { issuedAt: 1_420 }, { validBefore: 1_120 }, { dispatchDeadlineSeconds: 300 },
    )).not.toThrow();
  });

  it("rejects a dispatch that resurrects a stale settlement", () => {
    expect(() => assertDispatchWithinQuoteSettlementWindow(
      { issuedAt: 1_421 }, { validBefore: 1_120 }, { dispatchDeadlineSeconds: 300 },
    )).toThrow("too long after the quote payment window");
  });
});

import type { Hex } from "viem";

export interface AuthorizationUsedLog {
  logIndex: number | bigint;
  args: { authorizer?: Hex; nonce?: Hex };
}

/// The pinned canonical-token implementation (Circle FiatToken) emits
/// AuthorizationUsed immediately before the Transfer of the same EIP-3009
/// call, with no external call between the two emits, so the authorization
/// log sits at exactly depositLogIndex - 1. That adjacency is what proves
/// the selected deposit transfer was produced by the payer's authorization
/// rather than an unrelated authorization spliced into the same transaction
/// next to an allowance-based transferFrom. It holds only while the token
/// implementation runtime code hash stays pinned in the outcome config.
export function selectDepositAuthorization<T extends AuthorizationUsedLog>(
  payerAuthorizations: readonly T[],
  binding: { depositLogIndex: number; expectedNonce: Hex | null },
): T {
  const bound = payerAuthorizations.filter((event) =>
    Number(event.logIndex) === binding.depositLogIndex - 1 &&
    event.args.nonce !== undefined &&
    (binding.expectedNonce === null || event.args.nonce === binding.expectedNonce)
  );
  if (bound.length !== 1) {
    throw new Error("Deposit authorization does not bind the settlement transfer");
  }
  return bound[0]!;
}

/// Settlement must have happened inside the quote's payment window. The
/// 30-second allowance covers sequencer clock skew ahead of the quoting
/// clock; a deposit block stamped after validBefore is a stale quote and a
/// deposit stamped before issuance is a replayed or spliced settlement.
export function assertDepositWithinQuoteWindow(
  depositTimestamp: number,
  quote: { issuedAt: number; validBefore: number },
): void {
  if (
    !Number.isSafeInteger(depositTimestamp) || depositTimestamp <= 0 ||
    depositTimestamp + 30 < quote.issuedAt || depositTimestamp > quote.validBefore
  ) {
    throw new Error("Deposit settlement is outside the quote payment window");
  }
}

/// Dynamic quotes must carry the payment window the provider committed to
/// in its quote policy; fixed-price outcomes pin both bounds to zero and
/// take their price from current listing config instead.
export function assertQuoteWindowPolicy(
  quote: { issuedAt: number; validBefore: number },
  outcome: {
    pricingMode: "fixed" | "dynamic";
    quoteMaximumLifetimeSeconds: number;
    quoteMinimumPaymentWindowSeconds: number;
  },
): void {
  if (outcome.pricingMode !== "dynamic") return;
  const lifetime = quote.validBefore - quote.issuedAt;
  if (
    lifetime < outcome.quoteMinimumPaymentWindowSeconds ||
    lifetime > outcome.quoteMaximumLifetimeSeconds
  ) {
    throw new Error("Quote payment window violates the outcome quote policy");
  }
}

/// A fresh dispatch signature must not resurrect an old settlement: the
/// gateway gets one dispatch-deadline period after the quote payment window
/// closes (finality plus assembly) to deliver the dispatch.
export function assertDispatchWithinQuoteSettlementWindow(
  dispatch: { issuedAt: number },
  quote: { validBefore: number },
  outcome: { dispatchDeadlineSeconds: number },
): void {
  if (dispatch.issuedAt > quote.validBefore + outcome.dispatchDeadlineSeconds) {
    throw new Error("Dispatch was issued too long after the quote payment window");
  }
}

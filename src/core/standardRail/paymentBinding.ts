import type { Hex } from "viem";

export interface AuthorizationUsedLog {
  logIndex: number | bigint;
  args: { authorizer?: Hex; nonce?: Hex };
}

/// The pinned canonical-token implementation (Circle FiatToken) emits
/// AuthorizationUsed immediately before the Transfer of the same EIP-3009
/// call, with no external call between the two emits, so the authorization
/// log sits at exactly depositLogIndex - 1. That adjacency proves the selected
/// deposit transfer came from the payer authorization rather than an unrelated
/// authorization spliced next to an allowance-based transferFrom.
export function selectDepositAuthorization<T extends AuthorizationUsedLog>(
  payerAuthorizations: readonly T[],
  binding: { depositLogIndex: number; expectedNonce: Hex | null },
): T {
  const bound = payerAuthorizations.filter((event) =>
    Number(event.logIndex) === binding.depositLogIndex - 1
    && event.args.nonce !== undefined
    && (binding.expectedNonce === null || event.args.nonce === binding.expectedNonce)
  );
  if (bound.length !== 1) {
    throw new Error("Deposit authorization does not bind the settlement transfer");
  }
  return bound[0]!;
}

/// Settlement must happen inside the quote's payment window, judged by the
/// authenticated deposit block timestamp rather than by when the dispatch
/// arrives: the gateway may dispatch a timely payment long after the quote
/// expired. The EIP-3009 authorization cannot settle after its validBefore,
/// which the gateway caps at the quote's validBefore. Thirty seconds covers
/// sequencer clock skew ahead of the quoting clock.
export function assertDepositWithinQuoteWindow(
  depositTimestamp: number,
  quote: { issuedAt: number; validBefore: number },
): void {
  if (
    !Number.isSafeInteger(depositTimestamp) || depositTimestamp <= 0
    || depositTimestamp + 30 < quote.issuedAt
    || depositTimestamp > quote.validBefore
  ) {
    throw new Error("Deposit settlement is outside the quote payment window");
  }
}

/// The minimal starter accepts only fixed listing quotes. The runtime check is
/// intentionally retained even though configuration parsing enforces it too.
export function assertFixedQuotePolicy(outcome: {
  pricingMode: string;
  quoteMaximumLifetimeSeconds: number;
  quoteMinimumPaymentWindowSeconds: number;
}): void {
  if (
    outcome.pricingMode !== "fixed"
    || outcome.quoteMaximumLifetimeSeconds !== 0
    || outcome.quoteMinimumPaymentWindowSeconds !== 0
  ) {
    throw new Error("Outcome must use the fixed one-shot quote policy");
  }
}

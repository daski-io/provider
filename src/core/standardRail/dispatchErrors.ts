/**
 * Dispatch recovery has three distinct outcomes (C03):
 *
 * - a definite refusal before any admission, answered with a bounded JSON
 *   `{error: "dispatch_rejected", reason}` so the gateway retries with a new
 *   signed envelope;
 * - durable admission exists or its commit is uncertain, answered with the
 *   signed snapshot or, failing that, an ambiguous empty-body 503 so the
 *   gateway status-polls the original dispatch hash; and
 * - a fresh signed status query whose authoritative lookup finds no claim,
 *   answered with the one reviewed no-claim 404.
 */
export const DISPATCH_REJECTION_REASONS = [
  "quote_window", "envelope_lifetime", "signature", "outcome_policy",
  "self_purchase", "price", "validator", "evidence", "service_unavailable",
] as const;

export type DispatchRejectionReason = typeof DISPATCH_REJECTION_REASONS[number];

/** Definite refusal; thrown only where no admission can exist for this request. */
export class DispatchRejectedError extends Error {
  constructor(
    readonly reason: DispatchRejectionReason,
    /** False when the envelope was not yet proven to come from the gateway. */
    readonly authenticated = true,
    message: string = reason,
  ) {
    super(message);
    this.name = "DispatchRejectedError";
  }
}

/** Admission exists or may exist: never answer this with a JSON `error`. */
export class DispatchAmbiguousError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "DispatchAmbiguousError";
  }
}

export async function withDispatchRejection<T>(
  reason: DispatchRejectionReason,
  work: () => T | Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DispatchRejectedError) throw error;
    throw new DispatchRejectedError(reason, true, error instanceof Error ? error.message : reason);
  }
}

export type DispatchStatusRejection = "query_invalid" | "signature" | "binding_conflict";

/** A status query that was not answered and proves nothing about claims. */
export class DispatchStatusRejectedError extends Error {
  constructor(readonly reason: DispatchStatusRejection, readonly authenticated: boolean) {
    super(`dispatch status ${reason}`);
    this.name = "DispatchStatusRejectedError";
  }
}

/** Only an authenticated, fresh query with an authoritative empty lookup. */
export class DispatchStatusNoClaimError extends Error {
  constructor() {
    super("No dispatch claim exists for this order");
    this.name = "DispatchStatusNoClaimError";
  }
}

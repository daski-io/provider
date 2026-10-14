import type { Hex } from "viem";

/** One reviewed, buyer-safe reason a request cannot be quoted yet. */
export interface RequestFieldError {
  /** Request field the reason applies to, such as `domain` or `$` for the whole request. */
  path: string;
  /** Stable lowercase rule code, such as `required` or `not_verified`. */
  rule: string;
  /** Reviewed public explanation; never upstream text or request values. */
  message: string;
  allowedValues?: readonly string[];
}

export interface RequestReadinessContext {
  skillId: string;
  /** A private copy of the request, already valid for the published schema. */
  input: Record<string, unknown>;
  /** Lowercase payer bound by the gateway quote request, or null when unbound. */
  payer: Hex | null;
  /** Aborted when core's bounded readiness budget expires. */
  signal: AbortSignal;
}

/**
 * Result of the optional pre-quote readiness hook. It can only accept or
 * decline the request; core alone selects and signs the fixed amount.
 */
export type RequestReadiness =
  | { ready: true }
  | { ready: false; fieldErrors: readonly RequestFieldError[] };

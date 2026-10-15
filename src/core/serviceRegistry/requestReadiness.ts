import type { Hex } from "viem";
import type { SupplierCost } from "./supplierCost.js";

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
 * decline the request; core alone selects and signs the fixed amount. A
 * service that pays a supplier reports the supplier's current price for
 * this request as `supplierCost`: core records it with the quote, with the
 * configured tolerance, as the order's spend ceiling. Omit it when the
 * service spends nothing at a supplier.
 */
export type RequestReadiness =
  | { ready: true; supplierCost?: SupplierCost }
  | { ready: false; fieldErrors: readonly RequestFieldError[] };

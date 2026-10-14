import type { RequestFieldError } from "../serviceRegistry/types.js";

export type QuoteRefusalReason =
  | "envelope"
  | "signature"
  | "outcome_policy"
  | "binding"
  | "price"
  | "request_invalid";

export type QuoteUnavailableReason =
  | "capacity" | "sales_paused" | "service_unavailable" | "contract_drift";

/**
 * A definite, bounded refusal of a quote or intake request. The gateway turns
 * any 4xx into PROVIDER_QUOTE_REJECTED and reads only `fieldErrors`.
 */
export class QuoteRefusal extends Error {
  constructor(
    readonly kind: "quote" | "intake",
    readonly status: 400 | 401 | 409 | 422,
    readonly reason: QuoteRefusalReason,
    readonly fieldErrors?: readonly RequestFieldError[],
  ) {
    super(`${kind} refused: ${reason}`);
    this.name = "QuoteRefusal";
  }

  body(): Record<string, unknown> {
    return {
      error: `${this.kind}_rejected`,
      reason: this.reason,
      ...(this.fieldErrors ? { fieldErrors: this.fieldErrors } : {}),
    };
  }
}

/** New sales are temporarily stopped; the gateway may retry the quote later. */
export class QuoteUnavailable extends Error {
  constructor(readonly reason: QuoteUnavailableReason) {
    super(`quote unavailable: ${reason}`);
    this.name = "QuoteUnavailable";
  }
}

/// Keep a refusal well inside the gateway's 32 KiB rejection read so the
/// field errors stay usable; drop trailing entries rather than truncating text.
export function boundedRefusalBody(refusal: QuoteRefusal, maxBytes = 16_384): Record<string, unknown> {
  const fieldErrors = [...(refusal.fieldErrors ?? [])];
  let body = refusal.body();
  while (fieldErrors.length > 1 && Buffer.byteLength(JSON.stringify(body), "utf8") > maxBytes) {
    fieldErrors.pop();
    body = { ...body, fieldErrors: [...fieldErrors] };
  }
  return body;
}

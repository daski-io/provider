/**
 * Lifecycle refusals (gateway G02). The named refusals are the only provider
 * bodies the gateway shows a buyer: exactly one key, `error`, at exactly
 * this status. Everything else the handler refuses is a fault the gateway
 * keeps internal.
 */
export type NamedLifecycleRefusal = "artifact_unavailable" | "unsupported_action";

/** 409 with exactly `{"error": code}`; nothing happened. */
export class LifecycleRefusal extends Error {
  constructor(readonly code: NamedLifecycleRefusal) {
    super(`lifecycle refused: ${code}`);
    this.name = "LifecycleRefusal";
  }
}

export type LifecycleRejection =
  | "request_invalid"
  | "grant"
  | "signature"
  | "binding"
  | "authorization"
  | "unknown_task";

const REJECTION_STATUS: Readonly<Record<LifecycleRejection, number>> = {
  request_invalid: 400,
  grant: 401,
  signature: 401,
  binding: 403,
  authorization: 403,
  unknown_task: 404,
};

/**
 * A call that is not a valid gateway lifecycle request for one of this
 * provider's tasks. A correct gateway never sends one, so the answer is a
 * bounded fault, never a named refusal and never data.
 */
export class LifecycleRejectedError extends Error {
  constructor(
    readonly reason: LifecycleRejection,
    /** False until the gateway grant's signature has been verified. */
    readonly authenticated: boolean,
  ) {
    super(`lifecycle rejected: ${reason}`);
    this.name = "LifecycleRejectedError";
  }

  get status(): number {
    return REJECTION_STATUS[this.reason];
  }
}

/** 503 with exactly `{"error": "lifecycle_unavailable"}`: retry later, nothing was decided. */
export class LifecycleUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LifecycleUnavailableError";
  }
}

export const LIFECYCLE_UNAVAILABLE_BODY = Object.freeze({ error: "lifecycle_unavailable" });

import type { Hex } from "viem";

/** A JSON object exchanged with core: buyer input or a bounded job reference. */
export type JsonRecord = Record<string, unknown>;

export interface ServiceArtifact {
  name: string;
  data?: Record<string, unknown>;
  url?: string;
  mimeType?: string;
}

export type ServiceResult =
  | {
      status: "completed";
      message?: string;
      artifacts?: ServiceArtifact[];
    }
  | {
      status: "failed";
      message?: string;
      errorCode: string;
    };

export interface TaskContext {
  taskId: string;
  orderId: string;
  payer: Hex;
  serviceSlug: string;
  skillId: string;
  /**
   * Aborted when this call's budget ends: the synchronous execution budget,
   * or one external-job call's bounded limit (never the upstream job itself).
   */
  signal: AbortSignal;
}

/**
 * The synchronous mode: one call that returns a terminal result within the
 * synchronous execution budget. Keep this interface name, classes already
 * implement it; an adapter without a mode is synchronous.
 */
export interface FulfillmentAdapter {
  mode?: "sync";
  execute(
    context: TaskContext,
    input: Record<string, unknown>,
  ): Promise<ServiceResult>;
}

/** What core persisted for one external job, given to every call. */
export interface ExternalJobContext extends TaskContext {
  /** Stable for the order: retries, restarts and upgrades reuse it. */
  idempotencyKey: string;
  /** Unix seconds of durable acceptance, persisted by core. */
  acceptedAt: number;
  /** Unix seconds of the admitted overdue threshold, persisted by core. */
  fulfillmentDeadline: number;
  /** Unix seconds of the first recorded start intent; null before it. */
  firstStartAttemptAt: number | null;
  /**
   * Unix seconds until which a same-key replay is covered by the upstream
   * retention the adapter declared; null without a declaration. Never
   * extended by a retry.
   */
  idempotencyValidBefore: number | null;
  /** Bounds this call, not the entire upstream job. */
  signal: AbortSignal;
}

/** A bounded, typed reason a call did not reach a definitive answer. */
export type CallIssue = {
  code: "timeout" | "rate_limited" | "upstream_unavailable"
    | "invalid_response" | "adapter_fault";
  retryAfterSeconds?: number;
};

export type KnownStartOutcome =
  | { kind: "accepted"; job: JsonRecord; pollAfterSeconds?: number }
  | { kind: "terminal"; result: ServiceResult };

export type StartOutcome = KnownStartOutcome
  | { kind: "ambiguous"; issue: CallIssue };

export type StartRecovery =
  | KnownStartOutcome
  | { kind: "safe-to-start";
      basis: "authoritative-absence" | "idempotent-replay" }
  | { kind: "unknown"; issue?: CallIssue; retryAfterSeconds?: number };

export type PollOutcome =
  | { kind: "pending"; pollAfterSeconds?: number }
  | { kind: "terminal"; result: ServiceResult }
  | { kind: "retry"; issue: CallIssue };

/**
 * A product that already runs the paid work as its own asynchronous job.
 * Core admits the funded order durably; its worker then calls `start`,
 * `recoverStart` and `poll` according to the persisted phase, each under a
 * bounded signal. Any throw, abort, timeout or invalid return from `start`
 * is ambiguous; a throw from `recoverStart` is unknown and one from `poll`
 * is a retry. Only a definitive mapped product outcome may be terminal.
 */
export interface ExternalJobAdapter {
  mode: "external-job";
  /** Interprets the job references it produced; retained while jobs need it. */
  version: string;
  /** Documented minimum upstream guarantee for same-key replay, in seconds. */
  idempotencyRetentionSeconds?: number;
  start(context: ExternalJobContext, input: JsonRecord): Promise<StartOutcome>;
  /** Read-only: find the original job, or prove that a new start is safe. */
  recoverStart(context: ExternalJobContext, input: JsonRecord): Promise<StartRecovery>;
  /** Read-only: one look at the original upstream job. */
  poll(context: ExternalJobContext, job: JsonRecord): Promise<PollOutcome>;
}

/** What a service module's `adapter` may be; never rename the old interface. */
export type ServiceAdapter = FulfillmentAdapter | ExternalJobAdapter;

export const isExternalJobAdapter = (adapter: ServiceAdapter): adapter is ExternalJobAdapter =>
  adapter.mode === "external-job";

import type {
  ExternalJobAdapter,
  ExternalJobContext,
  JsonRecord,
} from "../serviceRegistry/types.js";
import type { ClaimedJob, HeldJobLease } from "./jobClaims.js";
import type { CallResult } from "./outcomes.js";

/** The persisted facts of one job, as every call receives them. */
export function callContext(
  job: ClaimedJob,
  signal: AbortSignal,
  start: { firstStartAttemptAt: number | null; idempotencyValidBefore: number | null } = job,
): ExternalJobContext {
  return {
    taskId: job.taskId,
    orderId: job.orderId,
    payer: job.payer,
    serviceSlug: job.serviceSlug,
    skillId: job.skillId,
    supplierCostCeiling: job.supplierCostCeiling,
    idempotencyKey: job.idempotencyKey,
    acceptedAt: job.acceptedAt,
    fulfillmentDeadline: job.fulfillmentDeadline,
    firstStartAttemptAt: start.firstStartAttemptAt,
    idempotencyValidBefore: start.idempotencyValidBefore,
    signal,
  };
}

export type AdapterMethod = "start" | "recoverStart" | "poll";

/**
 * The one place that invokes an external-job adapter. A call starts only
 * while the held lease surely outlasts it (its limit plus one renewal
 * interval), so no other worker can take the job over while core still
 * waits. The call is bounded by the per-call limit and by the job's lease:
 * either aborts the signal, and core stops waiting at once, even if the
 * adapter ignores the abort. Its late answer is never written (the outcome
 * was already decided, and every write is fenced by the lease). An abort
 * never proves the remote action stopped; the caller maps a timeout of
 * `start` to ambiguity.
 */
export async function callAdapter(args: {
  adapter: ExternalJobAdapter;
  method: AdapterMethod;
  job: ClaimedJob;
  argument: JsonRecord;
  start?: { firstStartAttemptAt: number | null; idempotencyValidBefore: number | null };
  timeoutMs: number;
  lease: Pick<HeldJobLease, "lost" | "covers">;
}): Promise<CallResult> {
  const leaseLost = args.lease.lost;
  if (leaseLost.aborted || !args.lease.covers(args.timeoutMs)) return { kind: "lease_lost" };
  const timeout = AbortSignal.timeout(args.timeoutMs);
  const signal = AbortSignal.any([timeout, leaseLost]);
  const context = callContext(args.job, signal, args.start ?? args.job);
  let stopWaiting: (() => void) | undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    stopWaiting = () => resolve("aborted");
    signal.addEventListener("abort", stopWaiting, { once: true });
  });
  try {
    const invoke = async (): Promise<unknown> => {
      switch (args.method) {
        case "start": return args.adapter.start(context, args.argument);
        case "recoverStart": return args.adapter.recoverStart(context, args.argument);
        case "poll": return args.adapter.poll(context, args.argument);
      }
    };
    const settled = invoke().then(
      (value) => ({ kind: "returned", value }) as const,
      () => ({ kind: "threw" }) as const,
    );
    const first = await Promise.race([settled, aborted]);
    if (first === "aborted") return leaseLost.aborted ? { kind: "lease_lost" } : { kind: "timeout" };
    // An answer that arrives after the lease was lost cannot be written.
    return leaseLost.aborted ? { kind: "lease_lost" } : first;
  } finally {
    if (stopWaiting) signal.removeEventListener("abort", stopWaiting);
  }
}

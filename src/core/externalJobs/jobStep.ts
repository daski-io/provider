import { pool } from "../db/pool.js";
import { logError, logWarn } from "../logger.js";
import { getExternalJobAdapter, getService } from "../serviceRegistry/registry.js";
import type { ServiceModule } from "../serviceRegistry/types.js";
import { EXTERNAL_JOB_NOT_STARTED, failureEvidence } from "../standardRail/serviceResult.js";
import { holdJobLease, type ClaimedJob } from "./jobClaims.js";
import { openJobField } from "./jobCodec.js";
import { finishJob, recordStartIntent, type StartIntent } from "./jobTransitions.js";
import { replayStartJournal } from "./journalHandoff.js";
import { pollVerdict, recoveryVerdict, startVerdict, type CallResult, type ReviewedIssue } from "./outcomes.js";
import {
  accepted,
  call,
  defer,
  delay,
  facts,
  input,
  terminal,
  write,
  type Step,
  type StepContext,
} from "./stepSupport.js";

export type { StepContext } from "./stepSupport.js";

/**
 * Margin a same-key replay must leave before its persisted horizon, beyond
 * the bounded call itself: clock skew and network between core and the
 * product.
 */
export const REPLAY_SAFETY_MARGIN_SECONDS = 120;

/**
 * Drive one claimed job through its persisted phase (L04):
 *
 *   queued      -> record the start intent, then call start
 *   starting    -> claimed only after its lease expired: an interrupted
 *                  start, which always enters reconciliation
 *   reconciling -> recoverStart with the original key
 *   polling     -> poll the original upstream job
 *
 * Each outcome is committed under the job's lease in one fenced write; no
 * transaction stays open across a call. A job is resumed only by the
 * adapter version that admitted it.
 */
export async function runJobStep(ctx: StepContext, job: ClaimedJob): Promise<void> {
  const adapter = getExternalJobAdapter(job.serviceSlug, job.adapterVersion);
  const service = getService(job.serviceSlug);
  if (!adapter || !service) {
    logError("External job's adapter version is not installed", { ...facts(job), diagnostic: "handler_missing" });
    await defer({ ctx, job } as Step, job.phase, "handler_missing");
    return;
  }
  const lease = holdJobLease(job, ctx.settings, (message) => logWarn(message, facts(job)));
  const step: Step = { ctx, job, adapter, lease };
  try {
    if (job.firstOverdue) {
      logWarn("External job passed its fulfillment deadline and stays nonterminal", {
        ...facts(job), diagnostic: "external_job_overdue", phase: job.phase,
      });
    }
    switch (job.phase) {
      case "queued": return await queued(step, service);
      case "starting": return await interrupted(step);
      case "reconciling": return await reconcile(step);
      case "polling": return await poll(step);
    }
  } catch (error) {
    // Unreadable state (a missing key, say) or an unexpected fault: back
    // off without calling anything; the job is never failed for it.
    logError("External job step failed", {
      ...facts(job), phase: job.phase, errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    await defer(step, job.phase, "step_fault");
  } finally {
    lease.stop();
  }
}

async function queued(step: Step, service: ServiceModule): Promise<void> {
  const { job } = step;
  // The deadline proves failure only for work that never started.
  if (job.now >= job.fulfillmentDeadline) {
    const outcome = await finishJob(job, "queued", failureEvidence(EXTERNAL_JOB_NOT_STARTED), { neverStarted: true });
    if (outcome === "committed") logWarn("External job failed: its deadline passed before any start", facts(job));
    return;
  }
  // A product outage delays the admitted job; it is never a new refusal.
  if (!(await step.ctx.ready(service))) {
    await write(step, "queued", {
      delaySeconds: delay(step, "failure", job.failureCount + 1, null),
      failures: "increment",
      errorCode: "product_unavailable",
    });
    return;
  }
  const intent = await recordStartIntent({
    job, from: "queued", retentionSeconds: step.adapter.idempotencyRetentionSeconds ?? null,
  });
  if (intent) await start(step, intent);
}

/** Call start under a recorded intent; any non-definitive answer reconciles. */
async function start(step: Step, intent: StartIntent): Promise<void> {
  step.job = { ...step.job, ...intent };
  const result = await call(step, "start", input(step), intent);
  if (result.kind === "lease_lost") return;
  const verdict = startVerdict(result);
  if (verdict.kind === "accepted") return accepted(step, "starting", verdict.job, verdict.pollAfterSeconds);
  if (verdict.kind === "terminal") {
    const outcome = await terminal(step, "starting", verdict.result);
    if (outcome !== "malformed") return;
    return ambiguous(step, { code: "invalid_response", retryAfterSeconds: null });
  }
  return ambiguous(step, verdict.issue);
}

async function ambiguous(step: Step, issue: ReviewedIssue): Promise<void> {
  const outcome = await write(step, "starting", {
    phase: "reconciling",
    delaySeconds: delay(step, "failure", step.job.failureCount + 1, issue.retryAfterSeconds),
    failures: "increment",
    errorCode: `start.${issue.code}`,
    journal: { ambiguous: issue.code },
  });
  if (outcome === "committed") logWarn("External job start is ambiguous; reconciling", { ...facts(step.job), issue: issue.code });
}

async function interrupted(step: Step): Promise<void> {
  const outcome = await write(step, "starting", {
    phase: "reconciling", delaySeconds: 0, failures: "keep", errorCode: "start.interrupted",
    journal: { ambiguous: "interrupted" },
  });
  if (outcome === "committed") logWarn("Interrupted external job start; reconciling", facts(step.job));
}

async function reconcile(step: Step): Promise<void> {
  const result: CallResult = await call(step, "recoverStart", input(step));
  if (result.kind === "lease_lost") return;
  const verdict = recoveryVerdict(result);
  if (verdict.kind === "accepted") return accepted(step, "reconciling", verdict.job, verdict.pollAfterSeconds);
  if (verdict.kind === "terminal") {
    if ((await terminal(step, "reconciling", verdict.result)) === "done") return;
    return unresolved(step, { code: "invalid_response", retryAfterSeconds: null }, null);
  }
  if (verdict.kind === "safe-to-start") return restart(step, verdict.basis);
  return unresolved(step, verdict.issue, verdict.retryAfterSeconds);
}

/**
 * Only core schedules a start after recovery, with the same key and
 * journal identity, and only while the verdict's basis holds: never past
 * the deadline, never after the original start is known to have executed,
 * and a same-key replay only with a declared retention whose persisted
 * horizon still leaves room for the call and a safety margin.
 */
async function restart(step: Step, basis: "authoritative-absence" | "idempotent-replay"): Promise<void> {
  const { job, adapter } = step;
  const retention = adapter.idempotencyRetentionSeconds ?? null;
  if (job.overdue || job.candidate || (basis === "idempotent-replay" && retention === null)) {
    return unresolved(step, null, null, "recover.restart_not_permitted");
  }
  // The journal decides whether the start is known to have executed: a
  // confirmed entry resolves only through this job's row, never by starting.
  const journal = await replayStartJournal(pool, step.ctx.keys, job);
  if (journal.state === "confirmed") return unresolved(step, null, null, "recover.restart_not_permitted");
  const intent = await recordStartIntent({
    job, from: "reconciling", retentionSeconds: retention,
    restart: {
      basis,
      replayMarginSeconds: Math.ceil(step.ctx.settings.callTimeoutMs / 1_000) + REPLAY_SAFETY_MARGIN_SECONDS,
    },
  });
  if (!intent) return unresolved(step, null, null, "recover.restart_not_permitted");
  logWarn("Starting an external job again after recovery", { ...facts(job), basis });
  await start(step, intent);
}

async function unresolved(
  step: Step,
  issue: ReviewedIssue | null,
  retryAfterSeconds: number | null,
  errorCode?: string,
): Promise<void> {
  const hint = Math.max(retryAfterSeconds ?? 0, issue?.retryAfterSeconds ?? 0) || null;
  await write(step, "reconciling", {
    delaySeconds: delay(step, "failure", step.job.reconciliationCount + 1, hint),
    failures: issue ? "increment" : "keep",
    reconciled: true,
    errorCode: errorCode ?? (issue ? `recover.${issue.code}` : "recover.unknown"),
  });
}

async function poll(step: Step): Promise<void> {
  const { job } = step;
  if (!job.reference) return defer(step, "polling", "reference_missing");
  const reference = openJobField(step.ctx.keys, "reference", job, job.reference);
  const result = await call(step, "poll", reference);
  if (result.kind === "lease_lost") return;
  const verdict = pollVerdict(result);
  if (verdict.kind === "terminal" && (await terminal(step, "polling", verdict.result)) === "done") return;
  if (verdict.kind === "pending") {
    // An ordinary pending poll never consumes the failure budget.
    await write(step, "polling", {
      delaySeconds: delay(step, "pending", 0, verdict.pollAfterSeconds),
      failures: "reset",
      succeeded: true,
      errorCode: null,
    });
    return;
  }
  const issue = verdict.kind === "retry" ? verdict.issue : { code: "invalid_response" as const, retryAfterSeconds: null };
  await write(step, "polling", {
    delaySeconds: delay(step, "failure", job.failureCount + 1, issue.retryAfterSeconds),
    failures: "increment",
    errorCode: `poll.${issue.code}`,
  });
}

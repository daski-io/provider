import { logError, logInfo } from "../logger.js";
import type { FieldEncryptionKeyRing } from "../security/fieldEncryption.js";
import type { ExternalJobAdapter, ServiceModule } from "../serviceRegistry/types.js";
import { judgeServiceResult, type ResultContract } from "../standardRail/serviceResult.js";
import { callAdapter, type AdapterMethod } from "./calls.js";
import type { ClaimedJob, HeldJobLease } from "./jobClaims.js";
import { openJobField, sealJobField, sealResultCandidate } from "./jobCodec.js";
import { finishJob, fenced, updateJob, type JobUpdate, type StartIntent } from "./jobTransitions.js";
import type { ActiveJobPhase } from "./phases.js";
import { nextRunDelaySeconds } from "./scheduling.js";
import type { ExternalJobWorkerSettings } from "./settings.js";

/** What one step needs besides its claimed job. */
export interface StepContext {
  settings: ExternalJobWorkerSettings;
  keys: FieldEncryptionKeyRing;
  random: () => number;
  /** The admitted result contract of the job's listing version. */
  contract(job: ClaimedJob): ResultContract | null;
  /** Bounded, read-only product readiness before a first start. */
  ready(service: ServiceModule): Promise<boolean>;
}

/** One claimed job, its adapter version and the lease held for the step. */
export interface Step {
  ctx: StepContext;
  job: ClaimedJob;
  adapter: ExternalJobAdapter;
  lease: HeldJobLease;
}

export const facts = (job: ClaimedJob) => ({ taskId: job.taskId, serviceSlug: job.serviceSlug, skillId: job.skillId });

export const delay = (step: Step, kind: "pending" | "failure", failures: number, hint: number | null) =>
  nextRunDelaySeconds({
    kind, failures, overdue: step.job.overdue, hintSeconds: hint, settings: step.ctx.settings, random: step.ctx.random,
  });

export function write(step: Step, expected: ActiveJobPhase, update: JobUpdate) {
  return fenced(step.job, expected, (client) => updateJob(client, step.job, update));
}

/** Back off a job that could not be stepped; a starting job keeps its lease until it expires. */
export async function defer(step: Step, phase: ActiveJobPhase, errorCode: string): Promise<void> {
  if (phase === "starting") return;
  await write(step, phase, {
    delaySeconds: delay(step, "failure", step.job.failureCount + 1, null),
    failures: "increment",
    errorCode,
  });
}

export const call = (step: Step, method: AdapterMethod, argument: Record<string, unknown>, start?: StartIntent) =>
  callAdapter({
    adapter: step.adapter, method, job: step.job, argument, start,
    timeoutMs: step.ctx.settings.callTimeoutMs, leaseLost: step.lease.lost,
  });

export const input = (step: Step) => openJobField(step.ctx.keys, "input", step.job, step.job.input);

export async function accepted(step: Step, from: ActiveJobPhase, job: Record<string, unknown>, hint: number | null) {
  const outcome = await write(step, from, {
    phase: "polling",
    reference: sealJobField(step.ctx.keys, "reference", step.job, job),
    delaySeconds: delay(step, "pending", 0, hint),
    failures: "reset",
    succeeded: true,
    progressed: true,
    errorCode: null,
    candidate: null,
    diagnostic: null,
  });
  if (outcome === "committed") logInfo("External job accepted by the product; polling", facts(step.job));
}

/**
 * A terminal answer: a valid result (or reviewed failure evidence) is
 * frozen. A completed result that fails the admitted contract is an
 * integration error, not proof of product failure: the job stays
 * nonterminal with a bounded encrypted candidate and a stable diagnostic,
 * and only authoritative retrieval continues (an immediate terminal start
 * reconciles through its original key). Returns "malformed" when the value
 * is no ServiceResult at all, for the caller to treat as an invalid return.
 */
export async function terminal(step: Step, from: ActiveJobPhase, value: unknown): Promise<"done" | "malformed"> {
  const { job } = step;
  const contract = step.ctx.contract(job);
  const judged = contract
    ? judgeServiceResult(value, contract)
    : { kind: "invalid" as const, diagnostic: { code: "result_contract_unavailable", keywords: [] }, candidate: value };
  if (judged.kind === "malformed") return "malformed";
  if (judged.kind === "frozen") {
    const outcome = await finishJob(job, from, judged.result);
    if (outcome === "committed") logInfo(`External job ${judged.result.status}`, facts(job));
    return "done";
  }
  logError("External job result failed its admitted result contract", {
    ...facts(job), diagnostic: judged.diagnostic.code, schemaKeywords: judged.diagnostic.keywords,
  });
  await write(step, from, {
    phase: from === "starting" ? "reconciling" : from,
    candidate: sealResultCandidate(step.ctx.keys, job, judged.candidate),
    diagnostic: judged.diagnostic.code,
    delaySeconds: delay(step, "failure", job.failureCount + 1, null),
    failures: "increment",
    errorCode: "result_invalid",
  });
  return "done";
}

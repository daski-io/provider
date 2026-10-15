import type { Queryable } from "../db/queryable.js";
import { RUNTIME_SCHEMA_EPOCH } from "../db/runtimeEpoch.js";
import { externalJobHealthCodes, inspectExternalJobs } from "../externalJobs/health.js";
import {
  INSTANCE_LIVENESS_SECONDS,
  WORKER_HEARTBEAT_MAX_AGE_SECONDS,
} from "../runtimeInstance.js";
import { readAsyncAdmission } from "../standardRail/asyncAdmission.js";
import type { CutoverInventory } from "../standardRail/legacyCutover.js";
import type { ExternalJobServicing } from "../standardRail/retainedObligations.js";
import { check, counted, MAX_LISTED_REFERENCES, type DiagnosticCheck } from "./checks.js";

/** The async-admission switch and whether this build would sell external jobs under it. */
export async function asyncAdmissionCheck(
  db: Queryable,
  externalJobServices: readonly string[],
): Promise<DiagnosticCheck> {
  const state = await readAsyncAdmission(db);
  const details = {
    enabled: state.enabled,
    changedAt: state.changedAt?.toISOString() ?? null,
    externalJobServices: [...externalJobServices],
  };
  if (state.enabled) return check("ASYNC_ADMISSION", "pass", "Async admission is on.", undefined, details);
  if (externalJobServices.length === 0) {
    return check("ASYNC_ADMISSION", "pass", "Async admission is off; this build installs no external-job service.",
      undefined, details);
  }
  return check("ASYNC_ADMISSION", "warn",
    "Async admission is off: new external-job quotes and dispatches are refused until it is activated.",
    "After the cutover, with compatible workers running, run npm run daski:async-admission and then -- --activate.",
    details);
}

export interface InstanceState {
  check: DiagnosticCheck;
  /** Running instances of this epoch whose external-job worker heartbeats. */
  liveWorkers: number;
}

/** Running instances (fresh heartbeat): their epoch, worker capability and worker heartbeat. */
export async function runtimeInstancesCheck(db: Queryable): Promise<InstanceState> {
  const rows = (await db.query<{
    id: string; runtime_epoch: number; revision: string; capabilities: Record<string, unknown>; worker_fresh: boolean;
  }>(
    `SELECT instance_id::text AS id, runtime_epoch, revision, capabilities,
            coalesce(worker_heartbeat_at, started_at) > now() - make_interval(secs => $2) AS worker_fresh
       FROM provider_runtime_instances
      WHERE stopped_at IS NULL AND heartbeat_at > now() - make_interval(secs => $1)
      ORDER BY started_at, instance_id`,
    [INSTANCE_LIVENESS_SECONDS, WORKER_HEARTBEAT_MAX_AGE_SECONDS],
  )).rows;
  const compatible = rows.filter((row) =>
    row.runtime_epoch === RUNTIME_SCHEMA_EPOCH && row.capabilities?.externalJobWorker === true);
  const incompatible = rows.filter((row) => !compatible.includes(row));
  const stoppedWorkers = compatible.filter((row) => !row.worker_fresh);
  const liveWorkers = compatible.length - stoppedWorkers.length;
  const details = {
    running: rows.length,
    liveWorkers,
    stoppedWorkers: stoppedWorkers.slice(0, MAX_LISTED_REFERENCES).map((row) => row.id),
    incompatible: incompatible.slice(0, MAX_LISTED_REFERENCES).map((row) => row.id),
    revisions: [...new Set(rows.map((row) => row.revision))].slice(0, MAX_LISTED_REFERENCES),
  };
  const problems = [
    ...(incompatible.length > 0
      ? [`${counted(incompatible.length, "is not a compatible external-job worker", "are not compatible external-job workers")} of schema epoch ${RUNTIME_SCHEMA_EPOCH}`]
      : []),
    ...(stoppedWorkers.length > 0
      ? [`${counted(stoppedWorkers.length, "has its worker", "have their workers")} silent for over ${WORKER_HEARTBEAT_MAX_AGE_SECONDS} seconds`]
      : []),
  ];
  if (problems.length > 0) {
    return {
      liveWorkers,
      check: check("RUNTIME_INSTANCES", "warn", `${counted(rows.length, "running instance")}: ${problems.join("; ")}.`,
        "Stop older processes and restart a stalled one; due work resumes from PostgreSQL.", details),
    };
  }
  return {
    liveWorkers,
    check: check("RUNTIME_INSTANCES", "pass", rows.length === 0
      ? "No provider process is running."
      : `${counted(rows.length, "running instance")}, each with a heartbeating external-job worker.`, undefined, details),
  };
}

/** Pre-R1 executions, synchronous execution leases and unresolved supplier mutations. */
export function executionChecks(inventory: CutoverInventory): DiagnosticCheck[] {
  const legacy = inventory.legacyExecutions;
  const leases = inventory.leasedExecutions;
  const journal = inventory.unresolvedSupplierOperations;
  return [
    legacy.count > 0
      ? check("LEGACY_EXECUTIONS", "fail",
        `${counted(legacy.count, "pre-R1 execution is", "pre-R1 executions are")} still executing without a lease; only the cutover resolves them.`,
        "Reconcile any product mutation they made, then run npm run daski:cutover -- --resolve-legacy --old-processes-stopped.",
        { count: legacy.count, oldestAgeSeconds: legacy.oldestAgeSeconds,
          taskIds: legacy.taskIds.slice(0, MAX_LISTED_REFERENCES) })
      : check("LEGACY_EXECUTIONS", "pass", "No pre-R1 execution awaits the cutover.", undefined, { count: 0 }),
    leases.expired > 0
      ? check("SYNC_EXECUTION_LEASES", "warn",
        `${counted(leases.expired, "synchronous execution holds an expired lease", "synchronous executions hold expired leases")}; a running process fails each as abandoned.`,
        "Start a compatible process if none runs; reconcile any product mutation before retrying it.", leases)
      : check("SYNC_EXECUTION_LEASES", "pass", `${counted(leases.live, "synchronous execution is", "synchronous executions are")} running under a live lease.`,
        undefined, leases),
    journal.intent + journal.ambiguous > 0
      ? check("SUPPLIER_OPERATIONS", "warn",
        `${counted(journal.intent + journal.ambiguous, "supplier operation is", "supplier operations are")} unresolved (intent ${journal.intent}, ambiguous ${journal.ambiguous}).`,
        "Reconcile them against the product's authoritative state; never repeat a mutation blindly.", journal)
      : check("SUPPLIER_OPERATIONS", "pass", "No supplier operation is unresolved.", undefined, journal),
  ];
}

const FAILING_CODES = new Set(["external_job_handler_missing", "external_job_key_missing", "external_job_result_invalid"]);

/**
 * Unfinished external jobs of this gateway audience, judged with the
 * servicing codes `/health/ready` reports. Without a heartbeating worker of
 * this epoch, unfinished jobs make no progress.
 */
export async function externalJobsCheck(
  db: Queryable,
  args: { servicing: ExternalJobServicing; leaseSeconds: number; gatewayAudience: string; liveWorkers: number },
): Promise<DiagnosticCheck> {
  const inspection = await inspectExternalJobs(db, args.servicing, args.leaseSeconds, args.gatewayAudience);
  const codes: string[] = externalJobHealthCodes(inspection, true);
  if (inspection.active > 0 && args.liveWorkers === 0) codes.unshift("external_job_worker_stopped");
  const details = { ...inspection, codes };
  if (codes.length === 0) {
    return check("EXTERNAL_JOBS", "pass", `${counted(inspection.active, "unfinished external job")}; none needs attention.`,
      undefined, details);
  }
  return check("EXTERNAL_JOBS", codes.some((code) => FAILING_CODES.has(code)) ? "fail" : "warn",
    `${counted(inspection.active, "unfinished external job")}: ${codes.join(", ")}.`,
    "See External-job servicing health in docs/troubleshooting.md for each code.", details);
}

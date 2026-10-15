import type { Queryable } from "../db/queryable.js";
import type { ExternalJobServicing } from "../standardRail/retainedObligations.js";

/** Consecutive failed calls from which a job is reported as failing (it is never failed for it). */
export const FAILING_JOB_THRESHOLD = 10;

/**
 * Stable servicing-health codes for external jobs. None is a wire state and
 * none fails a job: a worker that stopped claiming, leases nobody reclaimed,
 * work past its deadline, unresolved start ambiguity, a terminal result the
 * admitted contract refuses, repeated call failures, and unfinished jobs
 * this build cannot resume (adapter version) or open or seal (key). A
 * healthy worker waiting on a long upstream job reports none.
 */
export type ExternalJobHealthCode =
  | "external_job_worker_stopped"
  | "external_job_lease_stale"
  | "external_job_overdue"
  | "external_job_start_ambiguous"
  | "external_job_result_invalid"
  | "external_job_failing"
  | "external_job_handler_missing"
  | "external_job_key_missing";

/** Counts over unfinished jobs; no input, reference, key or task content. */
export interface ExternalJobInspection {
  active: number;
  staleLeases: number;
  overdue: number;
  startAmbiguous: number;
  resultInvalid: number;
  failing: number;
  handlerMissing: number;
  keyMissing: number;
}

/**
 * Read-only diagnostics (SELECT only) over the unfinished jobs of this
 * provider's gateway audience. A lease is stale once it expired more than
 * one lease length ago without being reclaimed, which no running compatible
 * worker allows. Without an active key, every unfinished job counts as one
 * this build cannot service: it could not seal the state they may produce.
 */
export async function inspectExternalJobs(
  db: Queryable,
  servicing: ExternalJobServicing,
  leaseSeconds: number,
  gatewayAudience: string,
): Promise<ExternalJobInspection> {
  const totals = (await db.query<Omit<ExternalJobInspection, "handlerMissing" | "keyMissing">>(
    `SELECT count(*)::int AS active,
            count(*) FILTER (WHERE j.lease_expires_at < now() - make_interval(secs => $1))::int AS "staleLeases",
            count(*) FILTER (WHERE j.overdue_at IS NOT NULL OR now() >= j.fulfillment_deadline)::int AS overdue,
            count(*) FILTER (WHERE j.phase='reconciling'
              OR (j.phase='starting' AND j.lease_expires_at <= now()))::int AS "startAmbiguous",
            count(*) FILTER (WHERE j.result_diagnostic IS NOT NULL)::int AS "resultInvalid",
            count(*) FILTER (WHERE j.failure_count >= $2)::int AS failing
       FROM provider_external_jobs j JOIN provider_transactions t ON t.id=j.task_id
      WHERE j.phase IN ('queued','starting','reconciling','polling') AND t.gateway_audience=$3`,
    [leaseSeconds, FAILING_JOB_THRESHOLD, gatewayAudience],
  )).rows[0];
  const groups = await db.query<{ slug: string; version: string; count: number; key_ids: string[] }>(
    `SELECT t.service_slug AS slug, j.adapter_version AS version, count(*)::int AS count,
            array_remove(array_agg(DISTINCT j.input_key_id)
              || array_agg(DISTINCT j.job_reference_key_id)
              || array_agg(DISTINCT j.result_candidate_key_id), NULL) AS key_ids
       FROM provider_external_jobs j JOIN provider_transactions t ON t.id=j.task_id
      WHERE j.phase IN ('queued','starting','reconciling','polling') AND t.gateway_audience=$1
      GROUP BY 1, 2`,
    [gatewayAudience],
  );
  let handlerMissing = 0;
  let keyMissing = 0;
  for (const group of groups.rows) {
    if (!servicing.adapterVersions(group.slug).has(group.version)) handlerMissing += group.count;
    if (!servicing.canSeal || group.key_ids.some((keyId) => !servicing.keyIds.has(keyId))) keyMissing += group.count;
  }
  return {
    active: totals?.active ?? 0,
    staleLeases: totals?.staleLeases ?? 0,
    overdue: totals?.overdue ?? 0,
    startAmbiguous: totals?.startAmbiguous ?? 0,
    resultInvalid: totals?.resultInvalid ?? 0,
    failing: totals?.failing ?? 0,
    handlerMissing,
    keyMissing,
  };
}

/** The codes an inspection and the local worker's liveness raise, in a stable order. */
export function externalJobHealthCodes(
  inspection: ExternalJobInspection | null,
  workerRunning: boolean,
): ExternalJobHealthCode[] {
  const codes: ExternalJobHealthCode[] = workerRunning ? [] : ["external_job_worker_stopped"];
  if (!inspection) return codes;
  const raised: Array<[number, ExternalJobHealthCode]> = [
    [inspection.staleLeases, "external_job_lease_stale"],
    [inspection.overdue, "external_job_overdue"],
    [inspection.startAmbiguous, "external_job_start_ambiguous"],
    [inspection.resultInvalid, "external_job_result_invalid"],
    [inspection.failing, "external_job_failing"],
    [inspection.handlerMissing, "external_job_handler_missing"],
    [inspection.keyMissing, "external_job_key_missing"],
  ];
  return [...codes, ...raised.filter(([count]) => count > 0).map(([, code]) => code)];
}

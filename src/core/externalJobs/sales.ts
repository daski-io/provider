import type { Queryable } from "../db/queryable.js";
import type { ExternalJobAdapter } from "../serviceRegistry/types.js";
import { readAsyncAdmission } from "../standardRail/asyncAdmission.js";
import type { ExternalJobRuntime } from "./runtime.js";

/** Why new sales of an external-job listing are stopped while servicing continues. */
export type ExternalJobSalesStop = "external_jobs_unavailable" | "invalid_result_mapping";

/**
 * New quotes for an external-job listing need everything a sold job needs
 * later: the database switch on (activation proved only compatible workers
 * run), an active key to seal the input, and this process's worker
 * running. They also stop while the adapter version new sales would use has
 * mapped a terminal product result to something its admitted contract
 * refuses: that integration is broken until a repaired mapper recovers the
 * job (it then finishes and clears the diagnostic) or new sales move to a
 * new adapter version. Any stop affects new sales only; admitted jobs,
 * funded dispatches and reads continue. An unreadable switch throws, which
 * the quote answers as unavailable.
 */
export async function externalJobSalesStop(
  runtime: Pick<ExternalJobRuntime, "keys" | "workerRunning">,
  db: Queryable,
  sale: { serviceSlug: string; skillId: string; adapter: ExternalJobAdapter },
): Promise<ExternalJobSalesStop | null> {
  if (!runtime.keys.activeKeyId || !runtime.workerRunning()) return "external_jobs_unavailable";
  if (!(await readAsyncAdmission(db)).enabled) return "external_jobs_unavailable";
  const broken = await db.query<{ broken: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM provider_external_jobs j JOIN provider_transactions t ON t.id=j.task_id
        WHERE j.result_diagnostic IS NOT NULL
          AND j.phase IN ('queued','starting','reconciling','polling')
          AND t.service_slug=$1 AND t.skill_id=$2 AND j.adapter_version=$3) AS broken`,
    [sale.serviceSlug, sale.skillId, sale.adapter.version],
  );
  return broken.rows[0]?.broken === true ? "invalid_result_mapping" : null;
}

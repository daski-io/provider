import type { Queryable } from "../db/queryable.js";
import { readAsyncAdmission } from "../standardRail/asyncAdmission.js";
import type { ExternalJobRuntime } from "./runtime.js";

/** Why new sales of an external-job listing are stopped while servicing continues. */
export type ExternalJobSalesStop = "external_jobs_unavailable";

/**
 * New quotes for an external-job listing need everything a sold job needs
 * later: the database switch on (activation proved only compatible workers
 * run), an active key to seal the input, and this process's worker
 * running. Any of them missing stops new sales only; admitted jobs, funded
 * dispatches and reads are unaffected. An unreadable switch throws, which
 * the quote answers as unavailable.
 */
export async function externalJobSalesStop(
  runtime: Pick<ExternalJobRuntime, "keys" | "workerRunning">,
  db: Queryable,
): Promise<ExternalJobSalesStop | null> {
  if (!runtime.keys.activeKeyId || !runtime.workerRunning()) return "external_jobs_unavailable";
  return (await readAsyncAdmission(db)).enabled ? null : "external_jobs_unavailable";
}

import type { Queryable } from "../db/queryable.js";
import { readDatabaseSchemaEpoch, RUNTIME_SCHEMA_EPOCH } from "../db/runtimeEpoch.js";
import { SYNC_EXECUTION_BUDGET_SECONDS } from "../serviceRegistry/deadlines.js";
import { canonicalHash } from "./canonical.js";
import { failureEvidence, PROVIDER_RESTARTED_DURING_EXECUTION } from "./serviceResult.js";

/** Listed task ids are opaque references, bounded so the report stays small. */
const MAX_LISTED_TASKS = 100;
/**
 * Core's own external-job start journal (START_JOURNAL_KIND in
 * externalJobs/journalHandoff.ts): core reconciles those entries itself
 * through recoverStart, so they are not operator work.
 */
export const CORE_START_JOURNAL_KIND = "external-job.start";
/**
 * A pre-R1 row younger than the synchronous budget plus this margin may still
 * belong to a call an old process is finishing; resolution leaves it alone.
 */
const LEGACY_RESOLUTION_MARGIN_SECONDS = 70;
export const LEGACY_RESOLUTION_MINIMUM_AGE_SECONDS =
  SYNC_EXECUTION_BUDGET_SECONDS + LEGACY_RESOLUTION_MARGIN_SECONDS;

export interface CutoverInventory {
  schemaEpoch: number;
  buildEpoch: number;
  /** Executing rows a pre-R1 process admitted: no lease, no resumable input or handle. */
  legacyExecutions: { count: number; oldestAgeSeconds: number | null; taskIds: string[] };
  /** R1 synchronous executions by lease state. */
  leasedExecutions: { live: number; expired: number };
  /**
   * Supplier mutations whose outcome is still intent or ambiguous, other
   * than core's external-job starts (reported with the external jobs).
   */
  unresolvedSupplierOperations: { intent: number; ambiguous: number };
}

/** Read-only inventory for the stop-and-drain cutover and the activation checks. */
export async function cutoverInventory(db: Queryable): Promise<CutoverInventory> {
  const legacy = await db.query<{ id: string; age: string }>(
    `SELECT id, floor(extract(epoch FROM now() - created_at))::bigint::text AS age
       FROM provider_transactions
      WHERE state='executing' AND execution_lease_token IS NULL
      ORDER BY created_at, id`,
  );
  const leased = await db.query<{ live: number; expired: number }>(
    `SELECT count(*) FILTER (WHERE execution_lease_expires_at > now())::int AS live,
            count(*) FILTER (WHERE execution_lease_expires_at <= now())::int AS expired
       FROM provider_transactions
      WHERE state='executing' AND execution_lease_token IS NOT NULL`,
  );
  const journal = await db.query<{ intent: number; ambiguous: number }>(
    `SELECT count(*) FILTER (WHERE state='intent')::int AS intent,
            count(*) FILTER (WHERE state='ambiguous')::int AS ambiguous
       FROM supplier_operations WHERE kind <> $1`,
    [CORE_START_JOURNAL_KIND],
  );
  return {
    schemaEpoch: await readDatabaseSchemaEpoch(db),
    buildEpoch: RUNTIME_SCHEMA_EPOCH,
    legacyExecutions: {
      count: legacy.rows.length,
      oldestAgeSeconds: legacy.rows[0] ? Number(legacy.rows[0].age) : null,
      taskIds: legacy.rows.slice(0, MAX_LISTED_TASKS).map((row) => row.id),
    },
    leasedExecutions: { live: leased.rows[0]?.live ?? 0, expired: leased.rows[0]?.expired ?? 0 },
    unresolvedSupplierOperations: {
      intent: journal.rows[0]?.intent ?? 0,
      ambiguous: journal.rows[0]?.ambiguous ?? 0,
    },
  };
}

/** Executing rows a pre-R1 process admitted, which nothing resolves automatically. */
export async function countLegacyExecutions(db: Queryable): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM provider_transactions
      WHERE state='executing' AND execution_lease_token IS NULL`,
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * The cutover's resolution of interrupted pre-R1 executions, run only after
 * the operator has stopped every old process (the barrier already keeps them
 * from finalizing): each lease-less executing row older than the synchronous
 * budget plus a margin is failed exactly as the pre-R1 image would have at
 * its next boot, `provider_restarted_during_execution`, now with its result
 * hash frozen. No input, job handle or lease is invented, and the supplier
 * journal is untouched, so any mutation stays as ambiguous as it was.
 */
export async function resolveLegacyExecutions(db: Queryable): Promise<string[]> {
  const evidence = failureEvidence(PROVIDER_RESTARTED_DURING_EXECUTION);
  const result = await db.query<{ id: string }>(
    `UPDATE provider_transactions
        SET state='failed',result=$1::jsonb,result_hash=$2,completed_at=now()
      WHERE state='executing' AND execution_lease_token IS NULL
        AND created_at <= now() - make_interval(secs => $3)
      RETURNING id`,
    [
      JSON.stringify(evidence),
      Buffer.from(canonicalHash(evidence).slice(2), "hex"),
      LEGACY_RESOLUTION_MINIMUM_AGE_SECONDS,
    ],
  );
  return result.rows.map((row) => row.id).sort();
}

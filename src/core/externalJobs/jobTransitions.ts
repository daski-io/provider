import { pool } from "../db/pool.js";
import { rollbackFailedTransaction, type Queryable, type TransactionClient } from "../db/queryable.js";
import type { ServiceResult } from "../serviceRegistry/types.js";
import { canonicalHash } from "../standardRail/canonical.js";
import type { ClaimedJob } from "./jobClaims.js";
import type { SealedField } from "./jobCodec.js";
import { journalStartAmbiguous, journalStartConfirmed, journalStartIntent } from "./journalHandoff.js";
import type { ReviewedIssue } from "./outcomes.js";
import type { ActiveJobPhase } from "./phases.js";

/**
 * How a fenced write ended: committed; not written because the lease was
 * lost or the job moved on (or the write failed before COMMIT); or unknown
 * because COMMIT itself failed. Anything but `committed` ends the step: the
 * job is re-evaluated from its persisted phase once its lease expires.
 */
export type FencedOutcome = "committed" | "lost" | "unknown";

/** Marks the overdue diagnostic once, the first time a write sees the deadline passed. */
const OVERDUE = "overdue_at=CASE WHEN overdue_at IS NULL AND now() >= fulfillment_deadline THEN now() ELSE overdue_at END";

class NotWritten extends Error {}

/**
 * One transaction under the job's lease: the row is locked only while this
 * holder still owns an unexpired lease in the expected phase, so a stale
 * worker (its lease expired or taken over) cannot change phase, schedule,
 * reference or result. No network call ever runs inside it.
 */
export async function fenced(
  job: ClaimedJob,
  expected: ActiveJobPhase,
  work: (client: Queryable) => Promise<void>,
): Promise<FencedOutcome> {
  const client = (await pool.connect()) as TransactionClient;
  let destroy = false;
  let commitSent = false;
  try {
    await client.query("BEGIN");
    const held = await client.query(
      `SELECT 1 FROM provider_external_jobs
        WHERE task_id=$1 AND lease_token=$2 AND lease_expires_at > now() AND phase=$3
        FOR UPDATE`,
      [job.taskId, job.leaseToken, expected],
    );
    if (held.rowCount !== 1) throw new NotWritten("lease lost");
    await work(client);
    commitSent = true;
    await client.query("COMMIT");
    return "committed";
  } catch {
    if (commitSent) {
      destroy = true;
      return "unknown";
    }
    destroy = await rollbackFailedTransaction(client);
    return "lost";
  } finally {
    client.release(destroy);
  }
}

const expectOne = (rowCount: number | null) => {
  if (rowCount !== 1) throw new NotWritten("no row written");
};

/** How one step leaves an active job: its next phase, schedule and diagnostics. */
export interface JobUpdate {
  phase?: ActiveJobPhase;
  delaySeconds: number;
  failures: "reset" | "increment" | "keep";
  reconciled?: boolean;
  succeeded?: boolean;
  progressed?: boolean;
  errorCode: string | null;
  /** The upstream job reference, sealed; recorded once. */
  reference?: SealedField;
  /** An invalid terminal result kept for later repair (null clears it). */
  candidate?: SealedField | null;
  /** A stable result diagnostic (null clears it). */
  diagnostic?: string | null;
  /**
   * The start journal's matching record, written in this same transaction:
   * `confirmed` when the start's outcome is now on the row (the handoff),
   * or the cause of a start whose outcome is unknown.
   */
  journal?: "confirmed" | { ambiguous: ReviewedIssue["code"] | "interrupted" };
}

/** Persist one step's outcome and release the lease until the next run. */
export async function updateJob(client: Queryable, job: ClaimedJob, update: JobUpdate): Promise<void> {
  await client.query(
    `UPDATE provider_external_jobs SET
        phase=COALESCE($2, phase),
        next_run_at=now() + make_interval(secs => $3),
        failure_count=CASE $4 WHEN 'reset' THEN 0 WHEN 'increment' THEN failure_count + 1 ELSE failure_count END,
        reconciliation_count=reconciliation_count + $5,
        last_success_at=CASE WHEN $6 THEN now() ELSE last_success_at END,
        last_progress_at=CASE WHEN $7 THEN now() ELSE last_progress_at END,
        last_error_code=$8,
        job_reference_ciphertext=COALESCE($9, job_reference_ciphertext),
        job_reference_key_id=COALESCE($10, job_reference_key_id),
        result_candidate_ciphertext=CASE WHEN $11 THEN $12 ELSE result_candidate_ciphertext END,
        result_candidate_key_id=CASE WHEN $11 THEN $13 ELSE result_candidate_key_id END,
        result_diagnostic=CASE WHEN $14 THEN $15 ELSE result_diagnostic END,
        lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
        ${OVERDUE}, revision=revision + 1
      WHERE task_id=$1`,
    [
      job.taskId, update.phase ?? null, update.delaySeconds, update.failures,
      update.reconciled ? 1 : 0, update.succeeded === true, update.progressed === true, update.errorCode,
      update.reference?.ciphertext ?? null, update.reference?.keyId ?? null,
      update.candidate !== undefined, update.candidate?.ciphertext ?? null, update.candidate?.keyId ?? null,
      update.diagnostic !== undefined, update.diagnostic ?? null,
    ],
  ).then((result) => expectOne(result.rowCount));
  if (update.journal === "confirmed") await journalStartConfirmed(client, job);
  else if (update.journal) await journalStartAmbiguous(client, job, update.journal.ambiguous);
}

/** The persisted start horizon and journal entry once a start intent is recorded. */
export interface StartIntent {
  firstStartAttemptAt: number;
  idempotencyValidBefore: number | null;
  journalOperationId: string;
}

/**
 * Record a start intent before the call: queued or reconciling becomes
 * starting under the same lease, the first attempt time and the conservative
 * replay horizon (first attempt plus the declared retention) are fixed once,
 * and no start is recorded at or after the fulfillment deadline. A restart
 * after recovery additionally needs its basis to still hold at this
 * database instant: proven absence, or a replay horizon that leaves room for
 * the bounded call plus a safety margin. The start journal records the same
 * intent in this transaction (begun, or reopened under the same identity; a
 * confirmed journal, a start known to have executed, refuses).
 */
export async function recordStartIntent(args: {
  job: ClaimedJob;
  from: "queued" | "reconciling";
  retentionSeconds: number | null;
  restart?: { basis: "authoritative-absence" | "idempotent-replay"; replayMarginSeconds: number };
}): Promise<StartIntent | null> {
  const { job } = args;
  let intent: StartIntent | null = null;
  const outcome = await fenced(job, args.from, async (client) => {
    const journalOperationId = await journalStartIntent(client, job);
    const result = await client.query<{ first: string; horizon: string | null }>(
      `UPDATE provider_external_jobs SET phase='starting', journal_operation_id=$5,
          first_start_attempt_at=COALESCE(first_start_attempt_at, now()),
          idempotency_valid_before=CASE WHEN first_start_attempt_at IS NULL AND $2::int IS NOT NULL
            THEN now() + make_interval(secs => $2::int) ELSE idempotency_valid_before END,
          start_attempts=start_attempts + 1, last_progress_at=now(), last_error_code=NULL,
          revision=revision + 1
        WHERE task_id=$1 AND now() < fulfillment_deadline
          AND ($3::text IS NULL OR $3 = 'authoritative-absence'
            OR (idempotency_valid_before IS NOT NULL
                AND now() + make_interval(secs => $4::int) < idempotency_valid_before))
        RETURNING floor(extract(epoch FROM first_start_attempt_at))::bigint::text AS first,
                  floor(extract(epoch FROM idempotency_valid_before))::bigint::text AS horizon`,
      [
        job.taskId, args.retentionSeconds, args.restart?.basis ?? null,
        args.restart?.replayMarginSeconds ?? 0, journalOperationId,
      ],
    );
    expectOne(result.rowCount);
    const row = result.rows[0]!;
    intent = {
      firstStartAttemptAt: Number(row.first),
      idempotencyValidBefore: row.horizon === null ? null : Number(row.horizon),
      journalOperationId,
    };
  });
  if (outcome === "committed") return intent;
  if (outcome === "lost") return null;
  // COMMIT outcome unknown: only the durable row decides whether the intent
  // exists. Without a provable intent, no call is made.
  const current = await pool.query<{ first: string | null; horizon: string | null; journal: string | null }>(
    `SELECT floor(extract(epoch FROM first_start_attempt_at))::bigint::text AS first,
            floor(extract(epoch FROM idempotency_valid_before))::bigint::text AS horizon,
            journal_operation_id AS journal
       FROM provider_external_jobs
      WHERE task_id=$1 AND phase='starting' AND lease_token=$2 AND lease_expires_at > now()`,
    [job.taskId, job.leaseToken],
  ).catch(() => null);
  const row = current?.rows[0];
  if (!row?.first || !row.journal) return null;
  return {
    firstStartAttemptAt: Number(row.first),
    idempotencyValidBefore: row.horizon === null ? null : Number(row.horizon),
    journalOperationId: row.journal,
  };
}

/**
 * Freeze a job's terminal result: the claim's state, result, its canonical
 * hash and completion time in one conditional write, and in the same
 * transaction the job's terminal phase with that hash, its encrypted state
 * cleared and its lease released. PostgreSQL holds the two together.
 */
export function finishJob(
  job: ClaimedJob,
  expected: ActiveJobPhase,
  result: ServiceResult,
  options: { neverStarted?: boolean; confirmJournal?: boolean } = {},
): Promise<FencedOutcome> {
  const hash = Buffer.from(canonicalHash(result).slice(2), "hex");
  return fenced(job, expected, async (client) => {
    if (options.neverStarted) {
      const due = await client.query(
        `SELECT 1 FROM provider_external_jobs
          WHERE task_id=$1 AND first_start_attempt_at IS NULL AND now() >= fulfillment_deadline`,
        [job.taskId],
      );
      expectOne(due.rowCount);
    }
    const claim = await client.query(
      `UPDATE provider_transactions SET state=$2,result=$3::jsonb,result_hash=$4,completed_at=now()
        WHERE id=$1 AND state='external_job'`,
      [job.taskId, result.status, JSON.stringify(result), hash],
    );
    expectOne(claim.rowCount);
    const finished = await client.query(
      `UPDATE provider_external_jobs SET phase=$2, result_hash=$3, finished_at=now(),
          input_ciphertext=NULL, input_key_id=NULL,
          job_reference_ciphertext=NULL, job_reference_key_id=NULL,
          result_candidate_ciphertext=NULL, result_candidate_key_id=NULL, result_diagnostic=NULL,
          lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
          last_progress_at=now(), last_success_at=now(), last_error_code=NULL,
          ${OVERDUE}, revision=revision + 1
        WHERE task_id=$1`,
      [job.taskId, result.status, hash],
    );
    expectOne(finished.rowCount);
    // A terminal answer from start or recovery is the start's outcome too.
    if (options.confirmJournal) await journalStartConfirmed(client, job);
  });
}

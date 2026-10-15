import type { Queryable } from "../db/queryable.js";
import type { FieldEncryptionKeyRing } from "../security/fieldEncryption.js";
import type { JsonRecord } from "../serviceRegistry/types.js";
import {
  beginSupplierOperation,
  confirmSupplierOperationWithJobReference,
  fingerprintRequest,
  getSupplierOperation,
  markSupplierOperationAmbiguous,
  reopenSupplierOperationIntent,
  type SupplierOperationErrorCode,
} from "../suppliers/operationJournal.js";
import { openJobField } from "./jobCodec.js";
import type { ReviewedIssue } from "./outcomes.js";

/**
 * Core owns the start journal of every external job: one supplier_operations
 * entry per job, keyed by (service, the job's stable idempotency key), that
 * records the start intent before each call, its ambiguity, and its
 * confirmation. The adapter never journals the same start again. The entry
 * confirms by naming the job row (external_job_task_id) in the same
 * transaction that persists the start's outcome there; its `result` stays
 * empty, so a replay follows the reference to the job row and decrypts it,
 * and never consumes a redacted placeholder as a job handle.
 */
export const START_JOURNAL_KIND = "external-job.start";

/** The identity of one job's start operation. */
export interface StartOperation {
  taskId: string;
  serviceSlug: string;
  idempotencyKey: string;
  journalOperationId: string | null;
}

/** Serialize with any other journal user of the same operation (the generic wrapper's lock). */
const lockOperation = (client: Queryable, job: StartOperation) => client.query(
  "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
  [job.serviceSlug, job.idempotencyKey],
);

/**
 * Record a start intent in the journal, in the transaction that records it
 * on the job: the first start begins the entry, a start after recovery
 * reopens it (ambiguous becomes intent again) under the same identity. A
 * confirmed entry cannot be reopened: its start is known to have executed.
 */
export async function journalStartIntent(client: Queryable, job: StartOperation): Promise<string> {
  await lockOperation(client, job);
  if (job.journalOperationId) {
    await reopenSupplierOperationIntent(job.journalOperationId, client);
    return job.journalOperationId;
  }
  const { op, fresh } = await beginSupplierOperation({
    serviceId: job.serviceSlug,
    transactionId: job.taskId,
    opKey: job.idempotencyKey,
    kind: START_JOURNAL_KIND,
    requestFingerprint: fingerprintRequest({ taskId: job.taskId, idempotencyKey: job.idempotencyKey }),
    db: client,
  });
  if (!fresh) await reopenSupplierOperationIntent(op.id, client);
  return op.id;
}

const AMBIGUITY: Readonly<Record<ReviewedIssue["code"] | "interrupted", SupplierOperationErrorCode>> = {
  timeout: "execute.transport",
  rate_limited: "execute.rate_limited",
  upstream_unavailable: "execute.server",
  invalid_response: "execute.unexpected",
  adapter_fault: "execute.unexpected",
  interrupted: "execute.ambiguous",
};

/** The start's outcome is unknown: the entry stays open for reconciliation, never blind retry. */
export async function journalStartAmbiguous(
  client: Queryable,
  job: StartOperation,
  cause: ReviewedIssue["code"] | "interrupted",
): Promise<void> {
  if (!job.journalOperationId) throw new Error("external job has no start journal");
  await lockOperation(client, job);
  await markSupplierOperationAmbiguous(job.journalOperationId, AMBIGUITY[cause], client);
}

/**
 * The handoff: the start definitely happened (the product accepted it or
 * answered with its result), so confirm the entry by naming this job row,
 * in the transaction that writes the outcome to the row. An entry already
 * confirmed for this job stays as it is.
 */
export async function journalStartConfirmed(client: Queryable, job: StartOperation): Promise<void> {
  if (!job.journalOperationId) throw new Error("external job has no start journal");
  await lockOperation(client, job);
  const current = await getSupplierOperation(job.serviceSlug, job.idempotencyKey, client);
  if (current?.state === "confirmed" && current.external_job_task_id === job.taskId) return;
  await confirmSupplierOperationWithJobReference(job.journalOperationId, job.taskId, client);
}

/**
 * Seconds until a job's last ambiguous start has been settled for
 * `settleSeconds` (0 once it has), on the database clock; null unless the
 * journal records the start as ambiguous. Recovery starts nothing earlier,
 * so a start request still in flight lands before another could be sent.
 */
export async function startSettlesIn(
  db: Queryable,
  job: Pick<StartOperation, "journalOperationId">,
  settleSeconds: number,
): Promise<number | null> {
  if (!job.journalOperationId) return null;
  const row = (await db.query<{ remaining: number }>(
    `SELECT GREATEST(0, ceil(extract(epoch FROM updated_at + make_interval(secs => $2) - now())))::int AS remaining
       FROM supplier_operations WHERE id=$1 AND state='ambiguous'`,
    [job.journalOperationId, settleSeconds],
  )).rows[0];
  return row ? row.remaining : null;
}

/** What the start journal says, its job-row reference followed and decrypted. */
export type StartReplay =
  | { state: "none" | "intent" | "ambiguous" | "failed" }
  | { state: "confirmed"; reference: JsonRecord | null; finished: boolean };

/**
 * Replay a job's start journal. A confirmed start resolves only through the
 * job row it names: the decrypted job reference while the job polls, or
 * none once it holds a result. Nothing is ever read from the entry's own
 * `result`.
 */
export async function replayStartJournal(
  db: Queryable,
  ring: FieldEncryptionKeyRing,
  job: Pick<StartOperation, "serviceSlug" | "idempotencyKey">,
): Promise<StartReplay> {
  const op = await getSupplierOperation(job.serviceSlug, job.idempotencyKey, db);
  if (!op) return { state: "none" };
  if (op.state !== "confirmed") return { state: op.state };
  if (!op.external_job_task_id || op.kind !== START_JOURNAL_KIND) {
    throw new Error("start journal is confirmed without its job-row reference");
  }
  const row = (await db.query<{
    phase: string;
    job_reference_ciphertext: string | null;
    job_reference_key_id: string | null;
  }>(
    `SELECT phase, job_reference_ciphertext, job_reference_key_id
       FROM provider_external_jobs WHERE task_id=$1`,
    [op.external_job_task_id],
  )).rows[0];
  if (!row) throw new Error("start journal names a missing job row");
  const reference = row.job_reference_ciphertext && row.job_reference_key_id
    ? openJobField(ring, "reference", { taskId: op.external_job_task_id, serviceSlug: job.serviceSlug }, {
      ciphertext: row.job_reference_ciphertext, keyId: row.job_reference_key_id,
    })
    : null;
  return { state: "confirmed", reference, finished: row.phase === "completed" || row.phase === "failed" };
}

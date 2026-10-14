import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import { inTransaction } from "../db/queryable.js";
import type { SealedField } from "./jobCodec.js";
import type { ActiveJobPhase } from "./phases.js";

/** One job claimed under this worker's lease, with everything its call needs. */
export interface ClaimedJob {
  taskId: string;
  orderId: string;
  payer: Hex;
  serviceSlug: string;
  skillId: string;
  listingManifestHash: Hex;
  phase: ActiveJobPhase;
  adapterVersion: string;
  idempotencyKey: string;
  journalOperationId: string | null;
  input: SealedField;
  reference: SealedField | null;
  candidate: SealedField | null;
  leaseToken: string;
  /** Unix seconds, from the database clock. */
  acceptedAt: number;
  fulfillmentDeadline: number;
  firstStartAttemptAt: number | null;
  idempotencyValidBefore: number | null;
  /** Past its fulfillment deadline (overdue), and whether this claim is the first to see it. */
  overdue: boolean;
  firstOverdue: boolean;
  failureCount: number;
  reconciliationCount: number;
  /** The database clock when the job was claimed. */
  now: number;
}

/** A (service, adapter version) pair this build can resume. */
export interface ServiceableVersion {
  serviceSlug: string;
  adapterVersion: string;
}

const CLAIM_LOCK = "daski-external-job-claims";
const epoch = (column: string) => `floor(extract(epoch FROM ${column}))::bigint::text`;

const sealed = (ciphertext: string | null, keyId: string | null): SealedField | null =>
  ciphertext && keyId ? { ciphertext, keyId } : null;

/**
 * Claim due jobs under fresh leases. Claims are serialized by a transaction
 * advisory lock and count every live lease, so at most `maxConcurrentCalls`
 * database-fenced calls run across all processes sharing the database. Only
 * jobs whose persisted adapter version this build can resume are claimed;
 * a job whose lease expired is due again (its interrupted call is then
 * reconciled, never repeated blindly).
 */
export async function claimDueJobs(args: {
  owner: string;
  limit: number;
  leaseSeconds: number;
  maxConcurrentCalls: number;
  serviceable: readonly ServiceableVersion[];
}): Promise<ClaimedJob[]> {
  if (args.limit < 1 || args.serviceable.length === 0) return [];
  return inTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [CLAIM_LOCK]);
    const live = await client.query<{ live: number }>(
      `SELECT count(*)::int AS live FROM provider_external_jobs
        WHERE lease_expires_at > now() AND phase IN ('queued','starting','reconciling','polling')`,
    );
    const free = Math.min(args.limit, args.maxConcurrentCalls - (live.rows[0]?.live ?? 0));
    if (free < 1) return [];
    const claimed = await client.query<Record<string, unknown>>(
      `WITH due AS (
         SELECT j.task_id FROM provider_external_jobs j
           JOIN provider_transactions t ON t.id=j.task_id
          WHERE j.phase IN ('queued','starting','reconciling','polling') AND j.next_run_at <= now()
            AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= now())
            AND (t.service_slug, j.adapter_version) IN (SELECT * FROM unnest($1::text[], $2::text[]))
          ORDER BY j.next_run_at, j.task_id
          LIMIT $3
          FOR UPDATE OF j SKIP LOCKED)
       UPDATE provider_external_jobs j
          SET lease_owner=$4, lease_token=gen_random_uuid(),
              lease_expires_at=now() + make_interval(secs => $5), revision=j.revision + 1
         FROM due, provider_transactions t
        WHERE j.task_id=due.task_id AND t.id=j.task_id
       RETURNING j.*, t.order_id, t.payer, t.service_slug, t.skill_id, t.listing_manifest_hash,
         ${epoch("j.accepted_at")} AS accepted_epoch, ${epoch("j.fulfillment_deadline")} AS deadline_epoch,
         ${epoch("j.first_start_attempt_at")} AS first_start_epoch,
         ${epoch("j.idempotency_valid_before")} AS horizon_epoch, ${epoch("now()")} AS now_epoch,
         (now() >= j.fulfillment_deadline) AS past_deadline`,
      [
        args.serviceable.map((entry) => entry.serviceSlug),
        args.serviceable.map((entry) => entry.adapterVersion),
        free, args.owner, args.leaseSeconds,
      ],
    );
    return claimed.rows.map(claimedJob);
  });
}

function claimedJob(row: Record<string, unknown>): ClaimedJob {
  const seconds = (value: unknown) => value === null || value === undefined ? null : Number(value);
  return {
    taskId: String(row.task_id),
    orderId: String(row.order_id),
    payer: row.payer as Hex,
    serviceSlug: String(row.service_slug),
    skillId: String(row.skill_id),
    listingManifestHash: `0x${(row.listing_manifest_hash as Buffer).toString("hex")}` as Hex,
    phase: row.phase as ActiveJobPhase,
    adapterVersion: String(row.adapter_version),
    idempotencyKey: String(row.idempotency_key),
    journalOperationId: (row.journal_operation_id as string | null) ?? null,
    input: sealed(row.input_ciphertext as string | null, row.input_key_id as string | null)!,
    reference: sealed(row.job_reference_ciphertext as string | null, row.job_reference_key_id as string | null),
    candidate: sealed(row.result_candidate_ciphertext as string | null, row.result_candidate_key_id as string | null),
    leaseToken: String(row.lease_token),
    acceptedAt: seconds(row.accepted_epoch)!,
    fulfillmentDeadline: seconds(row.deadline_epoch)!,
    firstStartAttemptAt: seconds(row.first_start_epoch),
    idempotencyValidBefore: seconds(row.horizon_epoch),
    overdue: row.past_deadline === true || row.overdue_at !== null,
    firstOverdue: row.past_deadline === true && row.overdue_at === null,
    failureCount: Number(row.failure_count),
    reconciliationCount: Number(row.reconciliation_count),
    now: seconds(row.now_epoch)!,
  };
}

/** Extend a held lease; false once it expired or was never this holder's. */
export async function renewJobLease(job: ClaimedJob, leaseSeconds: number): Promise<boolean> {
  const renewed = await pool.query(
    `UPDATE provider_external_jobs
        SET lease_expires_at=now() + make_interval(secs => $3), revision=revision + 1
      WHERE task_id=$1 AND lease_token=$2 AND lease_expires_at > now()`,
    [job.taskId, job.leaseToken, leaseSeconds],
  );
  return renewed.rowCount === 1;
}

/** One lease held for a whole step: renewed until stopped, its loss aborts the signal. */
export interface HeldJobLease {
  readonly lost: AbortSignal;
  stop(): void;
}

export function holdJobLease(
  job: ClaimedJob,
  timing: { leaseSeconds: number; leaseRenewMs: number },
  warn: (message: string) => void,
): HeldJobLease {
  const controller = new AbortController();
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing || controller.signal.aborted) return;
    renewing = true;
    renewJobLease(job, timing.leaseSeconds).then((held) => {
      if (held) return;
      warn("External job lease was lost");
      controller.abort();
    }, () => warn("External job lease could not be renewed")).finally(() => {
      renewing = false;
    });
  }, timing.leaseRenewMs);
  timer.unref();
  return { lost: controller.signal, stop: () => clearInterval(timer) };
}

import { performance } from "node:perf_hooks";
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
  /**
   * The local monotonic time (`performance.now()`, ms) until which this
   * holder can count on its lease: the claim's lease length measured from
   * before its transaction began, so never later than the database expiry.
   */
  leaseValidUntil: number;
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
 * jobs of this provider's gateway audience whose persisted adapter version
 * this build can resume are claimed; a job whose lease expired is due again
 * (its interrupted call is then reconciled, never repeated blindly).
 */
export async function claimDueJobs(args: {
  owner: string;
  gatewayAudience: string;
  limit: number;
  leaseSeconds: number;
  maxConcurrentCalls: number;
  serviceable: readonly ServiceableVersion[];
}): Promise<ClaimedJob[]> {
  if (args.limit < 1 || args.serviceable.length === 0) return [];
  const requestedAt = performance.now();
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
            AND t.gateway_audience=$6
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
        free, args.owner, args.leaseSeconds, args.gatewayAudience,
      ],
    );
    return claimed.rows.map((row) => claimedJob(row, requestedAt + args.leaseSeconds * 1_000));
  });
}

function claimedJob(row: Record<string, unknown>, leaseValidUntil: number): ClaimedJob {
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
    leaseValidUntil,
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
  /** Aborted once the lease is lost, or one renewal interval before it could expire unrenewed. */
  readonly lost: AbortSignal;
  /**
   * Whether a call bounded by `timeoutMs` ends while this holder surely
   * still holds the lease, with one renewal interval to spare: no other
   * worker can claim the job before the call has ended.
   */
  covers(timeoutMs: number): boolean;
  /** A fenced write extended the lease from a transaction begun after `requestedAt` (local monotonic ms). */
  extendedFrom(requestedAt: number): void;
  stop(): void;
}

/**
 * Hold a claimed lease for one step. Its validity is tracked locally from
 * the moment each claim, renewal or extension was requested (never later
 * than the database expiry it produced), so a holder whose renewals fail or
 * stall stops waiting on its call before any other worker can take the job
 * over, whatever the database answers.
 */
export function holdJobLease(
  job: ClaimedJob,
  timing: { leaseSeconds: number; leaseRenewMs: number },
  warn: (message: string) => void,
  deps: { renew?: typeof renewJobLease; clock?: () => number } = {},
): HeldJobLease {
  const renew = deps.renew ?? renewJobLease;
  const clock = deps.clock ?? (() => performance.now());
  const leaseMs = timing.leaseSeconds * 1_000;
  const controller = new AbortController();
  let validUntil = job.leaseValidUntil;
  let renewing = false;
  let stopped = false;
  let expiry: NodeJS.Timeout | undefined;
  const lose = (message: string) => {
    if (stopped || controller.signal.aborted) return;
    warn(message);
    controller.abort();
  };
  const arm = () => {
    clearTimeout(expiry);
    if (stopped || controller.signal.aborted) return;
    expiry = setTimeout(
      () => lose("External job lease could not be kept"),
      Math.max(0, validUntil - timing.leaseRenewMs - clock()),
    );
    expiry.unref();
  };
  const extendedFrom = (requestedAt: number) => {
    validUntil = Math.max(validUntil, requestedAt + leaseMs);
    arm();
  };
  arm();
  const timer = setInterval(() => {
    if (renewing || controller.signal.aborted) return;
    renewing = true;
    const requestedAt = clock();
    renew(job, timing.leaseSeconds).then((held) => {
      if (held) extendedFrom(requestedAt);
      else lose("External job lease was lost");
    }, () => warn("External job lease could not be renewed")).finally(() => {
      renewing = false;
    });
  }, timing.leaseRenewMs);
  timer.unref();
  return {
    lost: controller.signal,
    covers: (timeoutMs) => !controller.signal.aborted && validUntil - clock() >= timeoutMs + timing.leaseRenewMs,
    extendedFrom,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(expiry);
    },
  };
}

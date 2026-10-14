import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import { rollbackFailedTransaction, type Queryable, type TransactionClient } from "../db/queryable.js";
import type { ExternalJobPhase } from "../externalJobs/phases.js";
import { RUNTIME_INSTANCE_ID } from "../runtimeInstance.js";
import type { ServiceResult } from "../serviceRegistry/types.js";
import { canonicalHash } from "./canonical.js";
import { SYNC_LEASE } from "./syncLease.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

export interface ProviderTransaction {
  id: string;
  gateway_audience: string;
  order_id: string;
  dispatch_hash: Buffer;
  payer: Hex;
  service_slug: string;
  skill_id: string;
  /** The listing version (runtime commitment hash) the claim was admitted under. */
  listing_manifest_hash: Buffer;
  /**
   * `executing` is a synchronous execution; `external_job` an admitted
   * external job, whose progress is its job row's phase.
   */
  state: "executing" | "external_job" | "completed" | "failed";
  result: ServiceResult | null;
  /**
   * canonicalHash of `result`, frozen with the terminal transition. NULL for
   * pending rows and for rows that became terminal before it existed.
   */
  result_hash: Buffer | null;
  created_at: Date;
  completed_at: Date | null;
  operations_revision: number;
  operations_projection: unknown;
  /**
   * The process instance executing this claim and the fencing token of its
   * lease; NULL for rows a pre-R1 process admitted.
   */
  execution_owner?: string | null;
  execution_lease_token?: string | null;
  execution_lease_expires_at?: Date | null;
  /** Database clock (Unix seconds) when this row was read. */
  observed_at: string;
  /** The external job's phase, read with the claim; null for synchronous claims. */
  job_phase?: ExternalJobPhase | null;
}

/**
 * Every read stamps the database clock so each answer carries a fresh
 * observation, and carries an external job's phase from the same snapshot.
 */
const ROW = `*, floor(extract(epoch FROM now()))::bigint::text AS observed_at,
  (SELECT j.phase FROM provider_external_jobs j WHERE j.task_id=provider_transactions.id) AS job_phase`;

/**
 * How a new claim executes: a synchronous call under an execution lease, or
 * an external job inserted by the caller inside the claim's transaction.
 */
export type ClaimExecution =
  | { kind: "sync"; leaseSeconds?: number }
  | { kind: "external-job"; insertJob(client: Queryable, taskId: string): Promise<void> };

/** The deferred admission fence refused a claim at or after its envelope deadline. */
export class AdmissionExpiredError extends Error {
  constructor() {
    super("Dispatch admission deadline elapsed before commit");
    this.name = "AdmissionExpiredError";
  }
}

/** The execution's lease expired or was never this caller's: it cannot finalize. */
export class ExecutionLeaseLostError extends Error {
  constructor(readonly taskId: string) {
    super("Synchronous execution lease was lost before its result was persisted");
    this.name = "ExecutionLeaseLostError";
  }
}

/** COMMIT was sent but its outcome is unknown; the claim may exist. */
export class AdmissionUncertainError extends Error {
  constructor(readonly taskId: string, readonly cause: unknown) {
    super("Dispatch admission commit outcome is unknown");
    this.name = "AdmissionUncertainError";
  }
}

export const dispatchHashOf = (transaction: ProviderTransaction): Hex =>
  `0x${transaction.dispatch_hash.toString("hex")}` as Hex;

/** One indexed, read-only lookup of the claim for (gateway audience, order). */
export async function findTransaction(
  gatewayAudience: string,
  orderId: string,
): Promise<ProviderTransaction | null> {
  const result = await pool.query<ProviderTransaction>(
    `SELECT ${ROW} FROM provider_transactions WHERE gateway_audience=$1 AND order_id=$2`,
    [gatewayAudience, orderId],
  );
  return result.rows[0] ?? null;
}

const isAdmissionDeadline = (error: unknown) =>
  (error as { code?: string }).code === "23514"
  && (error as { constraint?: string }).constraint === "provider_transactions_admission_deadline";

/**
 * Claim one funded order. Capacity is never consulted here: the gateway has
 * already reserved it for this listing version and the order is paid. An
 * existing claim is returned unchanged for the caller to compare; the claim
 * cannot commit at or after `dispatchValidBefore` (database-enforced). Any
 * other error means this call admitted nothing, though a concurrent call
 * may have; callers re-check before refusing. A new synchronous claim is
 * owned by this process under a fresh lease token, generated here so that a
 * re-read after an unknown COMMIT recognizes it; a new external-job claim has
 * no execution lease and commits only together with its job row.
 */
export async function claimTransaction(args: {
  gatewayAudience: string;
  orderId: string;
  dispatchNonce: Hex;
  dispatchHash: Hex;
  requestHash: Hex;
  payer: Hex;
  serviceSlug: string;
  skillId: string;
  listingManifestHash: Hex;
  dispatchValidBefore: number;
  /** The persisted provider quote the order was paid against. */
  providerQuoteHash: Hex;
  /** Synchronous with its initial lease (the default), or an external job. */
  execution?: ClaimExecution;
}): Promise<{ transaction: ProviderTransaction; fresh: boolean }> {
  const id = `task-${randomUUID()}`;
  const execution = args.execution ?? { kind: "sync" };
  const leaseToken = execution.kind === "sync" ? randomUUID() : null;
  const client = (await pool.connect()) as TransactionClient;
  let destroy = false;
  let commitSent = false;
  try {
    await client.query("BEGIN");
    const existing = await client.query<ProviderTransaction>(
      `SELECT ${ROW} FROM provider_transactions
        WHERE gateway_audience=$1 AND order_id=$2 FOR UPDATE`,
      [args.gatewayAudience, args.orderId],
    );
    if (existing.rows[0]) {
      // The committed row is authoritative whatever happens to this
      // read-only transaction's COMMIT.
      await client.query("COMMIT").catch(() => { destroy = true; });
      return { transaction: existing.rows[0], fresh: false };
    }
    const inserted = await client.query<ProviderTransaction>(
      `INSERT INTO provider_transactions (
         id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
         service_slug,skill_id,listing_manifest_hash,state,dispatch_valid_before,
         execution_owner,execution_lease_token,execution_lease_expires_at,provider_quote_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$16,to_timestamp($11),
         $12,$13,now() + make_interval(secs => $14),$15)
       RETURNING ${ROW}`,
      [
        id, args.gatewayAudience, args.orderId, bytes(args.dispatchNonce),
        bytes(args.dispatchHash), bytes(args.requestHash), args.payer,
        args.serviceSlug, args.skillId, bytes(args.listingManifestHash),
        args.dispatchValidBefore,
        execution.kind === "sync" ? RUNTIME_INSTANCE_ID : null, leaseToken,
        execution.kind === "sync" ? execution.leaseSeconds ?? SYNC_LEASE.leaseSeconds : null,
        bytes(args.providerQuoteHash),
        execution.kind === "sync" ? "executing" : "external_job",
      ],
    );
    if (execution.kind === "external-job") await execution.insertJob(client, id);
    commitSent = true;
    await client.query("COMMIT");
    return { transaction: inserted.rows[0]!, fresh: true };
  } catch (error) {
    // The deferred fence reports at COMMIT and rolls the transaction back.
    if (isAdmissionDeadline(error)) throw new AdmissionExpiredError();
    if (commitSent) {
      destroy = true;
      throw new AdmissionUncertainError(id, error);
    }
    destroy = await rollbackFailedTransaction(client);
    throw error;
  } finally {
    client.release(destroy);
  }
}

/**
 * Freeze a task's terminal identity in one conditional write: state, result,
 * its canonical hash and the completion time change together and only from
 * `executing`, and only for the holder of the unexpired execution lease;
 * PostgreSQL refuses any later change to them. A stale holder writes
 * nothing: the durable terminal state is served if another writer finalized
 * the task, and otherwise its lease is lost.
 */
export async function completeTransaction(
  id: string,
  leaseToken: string,
  result: ServiceResult,
): Promise<ProviderTransaction> {
  const updated = await pool.query<ProviderTransaction>(
    `UPDATE provider_transactions
        SET state=$3,result=$4::jsonb,result_hash=$5,completed_at=now()
      WHERE id=$1 AND state='executing' AND execution_lease_token=$2
        AND execution_lease_expires_at > now()
      RETURNING ${ROW}`,
    [id, leaseToken, result.status, JSON.stringify(result), bytes(canonicalHash(result))],
  );
  if (updated.rows[0]) return updated.rows[0];
  const current = await getTransaction(id);
  if (!current) throw new Error("Transaction completion claim was lost");
  if (current.state === "executing") throw new ExecutionLeaseLostError(id);
  return current;
}

export async function getTransaction(id: string): Promise<ProviderTransaction | null> {
  const result = await pool.query<ProviderTransaction>(
    `SELECT ${ROW} FROM provider_transactions WHERE id=$1`,
    [id],
  );
  return result.rows[0] ?? null;
}

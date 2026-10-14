import { pool } from "../db/pool.js";
import { errorExtra, logError, logWarn } from "../logger.js";
import { canonicalHash } from "./canonical.js";
import { failureEvidence, SYNC_EXECUTION_ABANDONED } from "./serviceResult.js";

/**
 * Synchronous execution lease timing. A claim starts with a 30-second lease
 * that its owner renews every 10 seconds while the (at most 50-second) call
 * runs and its result is persisted, so two consecutive renewals can fail
 * without losing it. Any process sweeps expired leases every 15 seconds.
 */
export interface SyncLeaseTiming {
  leaseSeconds: number;
  renewMs: number;
  sweepMs: number;
}

export const SYNC_LEASE: Readonly<SyncLeaseTiming> = {
  leaseSeconds: 30,
  renewMs: 10_000,
  sweepMs: 15_000,
};

export interface SyncLease {
  /** Aborted once the lease is lost: the result can no longer be persisted. */
  readonly signal: AbortSignal;
  stop(): void;
}

/** Extend the lease while its holder still owns an unexpired one; false once it is lost. */
export async function renewSyncLease(
  taskId: string,
  leaseToken: string,
  leaseSeconds = SYNC_LEASE.leaseSeconds,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE provider_transactions
        SET execution_lease_expires_at=now() + make_interval(secs => $3)
      WHERE id=$1 AND state='executing' AND execution_lease_token=$2
        AND execution_lease_expires_at > now()`,
    [taskId, leaseToken, leaseSeconds],
  );
  return result.rowCount === 1;
}

/**
 * Keep renewing a claimed execution's lease until stopped. A failed renewal
 * query is not loss (the lease stays valid until it expires and the next
 * renewal or the fenced finalization decides); a renewal that finds the
 * lease expired or taken is, and aborts the signal.
 */
export function holdSyncLease(
  taskId: string,
  leaseToken: string,
  timing: SyncLeaseTiming = SYNC_LEASE,
): SyncLease {
  const controller = new AbortController();
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing || controller.signal.aborted) return;
    renewing = true;
    renewSyncLease(taskId, leaseToken, timing.leaseSeconds).then((held) => {
      if (held) return;
      logWarn("Synchronous execution lease was lost", { taskId });
      controller.abort();
    }, () => {
      logWarn("Synchronous execution lease could not be renewed", { taskId });
    }).finally(() => {
      renewing = false;
    });
  }, timing.renewMs);
  timer.unref();
  return {
    signal: controller.signal,
    stop: () => clearInterval(timer),
  };
}

/**
 * The documented failure policy for abandoned synchronous executions: a row
 * whose lease expired (its owner crashed, stalled or lost the database) is
 * failed with `provider_execution_abandoned`, frozen like any terminal
 * transition. Live calls of every process and lease-less pre-R1 rows are
 * never touched, and neither is the supplier journal: a mutation the call
 * may have made stays exactly as ambiguous as it was.
 */
export async function sweepAbandonedSyncExecutions(): Promise<string[]> {
  const evidence = failureEvidence(SYNC_EXECUTION_ABANDONED);
  const result = await pool.query<{ id: string }>(
    `UPDATE provider_transactions
        SET state='failed',result=$1::jsonb,result_hash=$2,completed_at=now()
      WHERE state='executing' AND execution_lease_expires_at IS NOT NULL
        AND execution_lease_expires_at <= now()
      RETURNING id`,
    [JSON.stringify(evidence), Buffer.from(canonicalHash(evidence).slice(2), "hex")],
  );
  return result.rows.map((row) => row.id);
}

/** Sweep now and then periodically; resolves after the first sweep. */
export async function startSyncLeaseSweeper(
  timing: SyncLeaseTiming = SYNC_LEASE,
): Promise<() => void> {
  const sweep = async () => {
    try {
      const failed = await sweepAbandonedSyncExecutions();
      if (failed.length > 0) {
        logWarn("Failed synchronous executions whose lease expired", { count: failed.length });
      }
    } catch (error) {
      logError("Abandoned synchronous executions could not be swept", errorExtra(error));
    }
  };
  await sweep();
  const timer = setInterval(() => void sweep(), timing.sweepMs);
  timer.unref();
  return () => clearInterval(timer);
}

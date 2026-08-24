import { pool } from "../db/pool.js";
import { inTransaction, type Queryable } from "../db/queryable.js";

export type SupplierBreakerState = "closed" | "open" | "half_open";

export interface SupplierCircuitBreakerRow {
  supplier: string;
  state: SupplierBreakerState;
  opened_at: Date | null;
  open_until: Date | null;
  failure_count: number;
  task_count: number;
  escalation_id: string | null;
  generation: string;
  probe_token: string | null;
  probe_expires_at: Date | null;
  updated_at: Date;
}

export interface SupplierFailureWindow {
  failureCount: number;
  taskCount: number;
}

export async function withSupplierBreakerLock<T>(
  supplier: string,
  work: (db: Queryable) => Promise<T>,
): Promise<T> {
  return inTransaction(pool, async (db) => {
    await db.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`supplier-breaker:${supplier}`],
    );
    return work(db);
  });
}

export async function insertSupplierBreakerFailure(
  db: Queryable,
  args: {
    supplier: string;
    transactionId: string;
    failureKind: string;
    failureKey?: string;
    failedAt: Date;
  },
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO supplier_breaker_failures
       (supplier, transaction_id, failure_kind, failure_key, failed_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (supplier, failure_key) WHERE failure_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      args.supplier,
      args.transactionId,
      args.failureKind,
      args.failureKey ?? null,
      args.failedAt,
    ],
  );
  return result.rows.length === 1;
}

export async function getSupplierFailureWindow(
  db: Queryable,
  supplier: string,
  cutoff: Date,
): Promise<SupplierFailureWindow> {
  const result = await db.query<{ failure_count: number; task_count: number }>(
    `SELECT COUNT(*)::int AS failure_count,
            COUNT(DISTINCT transaction_id)::int AS task_count
       FROM supplier_breaker_failures
      WHERE supplier = $1 AND failed_at >= $2`,
    [supplier, cutoff],
  );
  return {
    failureCount: result.rows[0]?.failure_count ?? 0,
    taskCount: result.rows[0]?.task_count ?? 0,
  };
}

export async function pruneSupplierBreakerFailures(
  db: Queryable,
  supplier: string,
  cutoff: Date,
): Promise<void> {
  await db.query(
    "DELETE FROM supplier_breaker_failures WHERE supplier = $1 AND failed_at < $2",
    [supplier, cutoff],
  );
}

export async function getSupplierBreakerForUpdate(
  db: Queryable,
  supplier: string,
): Promise<SupplierCircuitBreakerRow | null> {
  const result = await db.query<SupplierCircuitBreakerRow>(
    `SELECT * FROM supplier_circuit_breakers WHERE supplier = $1 FOR UPDATE`,
    [supplier],
  );
  return result.rows[0] ?? null;
}

export async function storeSupplierBreakerCounts(
  db: Queryable,
  supplier: string,
  window: SupplierFailureWindow,
): Promise<SupplierCircuitBreakerRow> {
  const result = await db.query<SupplierCircuitBreakerRow>(
    `INSERT INTO supplier_circuit_breakers
       (supplier, failure_count, task_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (supplier) DO UPDATE SET
       failure_count = EXCLUDED.failure_count,
       task_count = EXCLUDED.task_count,
       updated_at = now()
     RETURNING *`,
    [supplier, window.failureCount, window.taskCount],
  );
  return result.rows[0];
}

export async function openSupplierBreaker(
  db: Queryable,
  args: {
    supplier: string;
    openedAt: Date;
    openUntil: Date;
    window: SupplierFailureWindow;
  },
): Promise<SupplierCircuitBreakerRow> {
  const result = await db.query<SupplierCircuitBreakerRow>(
    `INSERT INTO supplier_circuit_breakers
       (supplier, state, opened_at, open_until, failure_count, task_count, generation)
     VALUES ($1, 'open', $2, $3, $4, $5, 1)
     ON CONFLICT (supplier) DO UPDATE SET
       state = 'open',
       opened_at = EXCLUDED.opened_at,
       open_until = EXCLUDED.open_until,
       failure_count = EXCLUDED.failure_count,
       task_count = EXCLUDED.task_count,
       escalation_id = NULL,
       generation = supplier_circuit_breakers.generation + 1,
       probe_token = NULL,
       probe_expires_at = NULL,
       updated_at = now()
     RETURNING *`,
    [
      args.supplier,
      args.openedAt,
      args.openUntil,
      args.window.failureCount,
      args.window.taskCount,
    ],
  );
  return result.rows[0];
}

export async function claimSupplierBreakerProbe(
  db: Queryable,
  args: {
    supplier: string;
    expectedGeneration: string;
    token: string;
    now: Date;
    leaseUntil: Date;
  },
): Promise<SupplierCircuitBreakerRow | null> {
  const result = await db.query<SupplierCircuitBreakerRow>(
    `UPDATE supplier_circuit_breakers
        SET state = 'half_open',
            generation = generation + 1,
            probe_token = $3,
            probe_expires_at = $5,
            updated_at = now()
      WHERE supplier = $1 AND state = 'open' AND generation = $2
        AND open_until IS NOT NULL AND open_until <= $4
      RETURNING *`,
    [args.supplier, args.expectedGeneration, args.token, args.now, args.leaseUntil],
  );
  return result.rows[0] ?? null;
}

export async function reopenSupplierBreakerProbe(
  db: Queryable,
  args: {
    supplier: string;
    generation: string;
    token: string;
    openedAt: Date;
    openUntil: Date;
    window: SupplierFailureWindow;
  },
): Promise<SupplierCircuitBreakerRow | null> {
  const result = await db.query<SupplierCircuitBreakerRow>(
    `UPDATE supplier_circuit_breakers
        SET state = 'open',
            opened_at = $4,
            open_until = $5,
            failure_count = $6,
            task_count = $7,
            probe_token = NULL,
            probe_expires_at = NULL,
            updated_at = now()
      WHERE supplier = $1 AND state = 'half_open'
        AND generation = $2 AND probe_token = $3
      RETURNING *`,
    [
      args.supplier,
      args.generation,
      args.token,
      args.openedAt,
      args.openUntil,
      args.window.failureCount,
      args.window.taskCount,
    ],
  );
  return result.rows[0] ?? null;
}

export async function closeSupplierBreakerProbe(
  db: Queryable,
  args: { supplier: string; generation: string; token: string },
): Promise<SupplierCircuitBreakerRow | null> {
  const result = await db.query<SupplierCircuitBreakerRow>(
    `UPDATE supplier_circuit_breakers
        SET state = 'closed', opened_at = NULL, open_until = NULL,
            failure_count = 0, task_count = 0, escalation_id = NULL,
            probe_token = NULL, probe_expires_at = NULL, updated_at = now()
      WHERE supplier = $1 AND state = 'half_open'
        AND generation = $2 AND probe_token = $3
      RETURNING *`,
    [args.supplier, args.generation, args.token],
  );
  return result.rows[0] ?? null;
}

export async function clearSupplierBreakerFailures(
  db: Queryable,
  supplier: string,
): Promise<void> {
  await db.query(`DELETE FROM supplier_breaker_failures WHERE supplier = $1`, [supplier]);
}

export async function linkSupplierBreakerEscalation(
  db: Queryable,
  supplier: string,
  escalationId: string,
): Promise<boolean> {
  const result = await db.query<{ escalation_id: string }>(
    `UPDATE supplier_circuit_breakers
        SET escalation_id = $2, updated_at = now()
      WHERE supplier = $1 AND state IN ('open','half_open') AND escalation_id IS NULL
      RETURNING escalation_id`,
    [supplier, escalationId],
  );
  return result.rows.length === 1;
}

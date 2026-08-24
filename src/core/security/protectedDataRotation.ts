import { randomUUID } from "node:crypto";
import type pg from "pg";
import { config } from "../config.js";
import { migrationPool } from "../db/pool.js";
import { withSessionAdvisoryLock } from "../db/sessionAdvisoryLock.js";
import { redactSensitiveText } from "./redaction.js";
import { allProtectedDataSinks } from "./protectedDataSinks.js";

const BATCH_SIZE = 100;
const ROTATION_LOCK = "daski-protected-data-rotation";

export interface ProtectedDataScan {
  keyCounts: Record<string, number>;
  unknownEnvelopeColumns: string[];
}

function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, count] of Object.entries(source)) target[key] = (target[key] ?? 0) + count;
}

export async function scanProtectedData(client?: pg.PoolClient): Promise<ProtectedDataScan> {
  const owned = client ?? await migrationPool.connect();
  try {
    const keyCounts: Record<string, number> = {};
    for (const sink of allProtectedDataSinks()) {
      let after: string | null = null;
      for (;;) {
        const batch = await sink.processBatch({ db: owned, after, limit: BATCH_SIZE });
        mergeCounts(keyCounts, batch.keyCounts);
        after = batch.lastCursor;
        if (batch.done) break;
      }
    }
    return {
      keyCounts,
      unknownEnvelopeColumns: await findUnknownEnvelopeColumns(owned),
    };
  } finally {
    if (!client) owned.release();
  }
}

async function findUnknownEnvelopeColumns(client: pg.PoolClient): Promise<string[]> {
  const registered = new Set(allProtectedDataSinks().flatMap((sink) => sink.registeredColumns));
  const columns = await client.query<{
    table_name: string;
    column_name: string;
  }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND data_type IN ('text','json','jsonb')
      ORDER BY table_name, ordinal_position`,
  );
  const unknown: string[] = [];
  for (const column of columns.rows) {
    const key = `${column.table_name}.${column.column_name}`;
    if (registered.has(key)) continue;
    const table = quoteIdentifier(column.table_name);
    const field = quoteIdentifier(column.column_name);
    const result = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM ${table} WHERE ${field}::text LIKE '%daski:v1:%' LIMIT 1
       ) AS present`,
    );
    if (result.rows[0]?.present) unknown.push(key);
  }
  return unknown;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function rotateProtectedData(args: {
  fromKeyId: string;
  runId?: string;
}): Promise<{ runId: string; rowsRotated: number; scan: ProtectedDataScan }> {
  if (!args.fromKeyId || args.fromKeyId === config.PROVIDER_DATA_ENCRYPTION_KEY_ID) {
    throw new Error("rotation source key must differ from the active write key");
  }
  const runId = args.runId ?? randomUUID();
  let rowsRotated = 0;
  const result = await withSessionAdvisoryLock({
    connect: () => migrationPool.connect(),
    async acquire(client) {
      await client.query(
        `SELECT pg_advisory_lock(hashtextextended($1, 0))`,
        [ROTATION_LOCK],
      );
      return { status: "acquired" };
    },
    async unlock(client) {
      await client.query(
        `SELECT set_config('daski.protected_data_rotation_run', '', false)`,
      );
      const unlocked = await client.query<{ unlocked: boolean }>(
        `SELECT pg_advisory_unlock(
           hashtextextended($1, 0)
         ) AS unlocked`,
        [ROTATION_LOCK],
      );
      return unlocked.rows[0]?.unlocked === true;
    },
    async work(client) {
      try {
        await ensureRun(client, runId, args.fromKeyId);
        await client.query(
          `SELECT set_config('daski.protected_data_rotation_run', $1, false)`,
          [runId],
        );
        for (const sink of allProtectedDataSinks()) {
          const progress = await client.query<{
            last_record_id: string | null;
            completed_at: Date | null;
          }>(
            `INSERT INTO protected_data_rotation_progress(run_id, sink)
             VALUES ($1,$2)
             ON CONFLICT (run_id, sink) DO UPDATE SET updated_at = now()
             RETURNING last_record_id, completed_at`,
            [runId, sink.name],
          );
          if (progress.rows[0].completed_at) continue;
          let after = progress.rows[0].last_record_id;
          for (;;) {
            await client.query("BEGIN");
            try {
              const batch = await sink.processBatch({
                db: client,
                after,
                limit: BATCH_SIZE,
                fromKeyId: args.fromKeyId,
              });
              rowsRotated += batch.rotated;
              after = batch.lastCursor;
              await client.query(
                `UPDATE protected_data_rotation_progress
                    SET last_record_id = $3,
                        rows_rotated = rows_rotated + $4,
                        completed_at = CASE WHEN $5 THEN now() ELSE NULL END,
                        updated_at = now()
                  WHERE run_id = $1 AND sink = $2`,
                [runId, sink.name, after, batch.rotated, batch.done],
              );
              await client.query("COMMIT");
              if (batch.done) break;
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            }
          }
        }
        const scan = await scanProtectedData(client);
        if ((scan.keyCounts[args.fromKeyId] ?? 0) !== 0) {
          throw new Error(
            `rotation source key still protects ${scan.keyCounts[args.fromKeyId]} values`,
          );
        }
        if (scan.unknownEnvelopeColumns.length > 0) {
          throw new Error(
            `unregistered protected-data sinks: ${scan.unknownEnvelopeColumns.join(", ")}`,
          );
        }
        await client.query(
          `UPDATE protected_data_rotation_runs
              SET status = 'completed', completed_at = now(),
                  updated_at = now(), last_error = NULL
            WHERE id = $1`,
          [runId],
        );
        return { runId, rowsRotated, scan };
      } catch (error) {
        const safe = redactSensitiveText((error as Error).message).slice(0, 1_000);
        await client.query(
          `UPDATE protected_data_rotation_runs
              SET status = 'failed', last_error = $2, updated_at = now()
            WHERE id = $1`,
          [runId, safe],
        ).catch(() => undefined);
        throw error;
      }
    },
  });
  if (result.status === "busy") {
    throw new Error("protected-data rotation lock unexpectedly reported busy");
  }
  return result.value;
}

async function ensureRun(client: pg.PoolClient, runId: string, fromKeyId: string): Promise<void> {
  const result = await client.query<{
    from_key_id: string;
    to_key_id: string;
    status: string;
  }>(
    `INSERT INTO protected_data_rotation_runs(id, from_key_id, to_key_id, status)
     VALUES ($1,$2,$3,'running')
     ON CONFLICT (id) DO UPDATE
       SET status = CASE
             WHEN protected_data_rotation_runs.status = 'completed' THEN 'completed'
             ELSE 'running'
           END,
           updated_at = now(), last_error = NULL
     RETURNING from_key_id, to_key_id, status`,
    [runId, fromKeyId, config.PROVIDER_DATA_ENCRYPTION_KEY_ID],
  );
  const run = result.rows[0];
  if (run.from_key_id !== fromKeyId || run.to_key_id !== config.PROVIDER_DATA_ENCRYPTION_KEY_ID) {
    throw new Error("rotation run key binding does not match the requested keys");
  }
  if (run.status === "completed") throw new Error("rotation run is already complete");
}

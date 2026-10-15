import type { Queryable } from "./queryable.js";

/**
 * The newest database schema epoch this build understands. Raise it, with
 * the provider_schema_epoch row, for any later migration that adds a table
 * or changes a guarded write path, since older runtimes cannot use such a
 * schema safely; a purely additive change no older path can misuse keeps
 * it, so compatible builds may overlap. Builds sharing an epoch are not told
 * apart: never run an intermediate build against a later build's database.
 */
export const RUNTIME_SCHEMA_EPOCH = 1;
/** Session setting every connection of this build carries (migration 005). */
export const RUNTIME_EPOCH_SETTING = "daski.runtime_epoch";

const MARKER_OPTION = `-c ${RUNTIME_EPOCH_SETTING}=${RUNTIME_SCHEMA_EPOCH}`;

/**
 * Connection parameters that set the runtime-epoch marker at session start,
 * kept together with any `options` the URL already carries (node-postgres
 * lets the URL override an explicit option). Without the marker the database
 * refuses every provider write and every migration-ledger read.
 */
export function withRuntimeEpochMarker(connectionString: string): {
  connectionString: string;
  options: string;
} {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return { connectionString, options: MARKER_OPTION };
  }
  const existing = url.searchParams.get("options")?.trim();
  if (!existing) return { connectionString, options: MARKER_OPTION };
  url.searchParams.delete("options");
  return { connectionString: url.toString(), options: `${existing} ${MARKER_OPTION}` };
}

/** The epoch the database declares; 0 before the barrier migration exists. */
export async function readDatabaseSchemaEpoch(db: Queryable): Promise<number> {
  const present = await db.query<{ present: boolean }>(
    "SELECT to_regclass('provider_schema_epoch') IS NOT NULL AS present",
  );
  if (!present.rows[0]?.present) return 0;
  const result = await db.query<{ epoch: number }>(
    "SELECT epoch FROM provider_schema_epoch WHERE singleton",
  );
  const epoch = result.rows[0]?.epoch;
  if (!Number.isSafeInteger(epoch) || (epoch as number) < 1) {
    throw new Error("database schema epoch is unreadable");
  }
  return epoch as number;
}

/** Refuse, before any mutation, a database whose schema is newer than this build. */
export function assertSupportedSchemaEpoch(epoch: number): void {
  if (epoch > RUNTIME_SCHEMA_EPOCH) {
    throw new Error(
      `database schema epoch ${epoch} is newer than this build supports `
      + `(${RUNTIME_SCHEMA_EPOCH}); refusing to start`,
    );
  }
}

// BEFORE (2) | INSERT (4) | DELETE (8) | UPDATE (16) | TRUNCATE (32); the
// ROW bit (1) must be clear: a statement trigger also fires for zero rows.
const STATEMENT_BARRIER_EVENTS = 62;

/**
 * After migrating, prove the barrier this build relies on is intact: the
 * epoch is exactly this build's, each of its tables (the migration ledger
 * included) carries the enabled statement-level barrier trigger, the ledger
 * forces its row-security policy, and this session's marker is admitted.
 */
export async function verifyCompatibilityBarrier(
  db: Queryable,
  providerTables: readonly string[],
): Promise<void> {
  const epoch = await readDatabaseSchemaEpoch(db);
  if (epoch !== RUNTIME_SCHEMA_EPOCH) {
    throw new Error(`database schema epoch ${epoch} is not this build's (${RUNTIME_SCHEMA_EPOCH})`);
  }
  const tables = await db.query<{
    table_name: string;
    guarded: boolean;
    row_security: boolean;
    forced: boolean;
    policy: boolean;
  }>(
    `SELECT c.relname AS table_name,
            EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
                     WHERE t.tgrelid=c.oid AND NOT t.tgisinternal
                       AND p.proname='provider_runtime_epoch_barrier'
                       AND t.tgenabled IN ('O','A')
                       AND (t.tgtype::integer & 1)=0
                       AND (t.tgtype::integer & $1)=$1) AS guarded,
            c.relrowsecurity AS row_security,
            c.relforcerowsecurity AS forced,
            EXISTS (SELECT 1 FROM pg_policy p
                     WHERE p.polrelid=c.oid AND p.polname='_migrations_runtime_epoch') AS policy
       FROM pg_class c
      WHERE c.relnamespace=current_schema()::regnamespace AND c.relkind IN ('r','p')
        AND c.relname=ANY($2::text[])`,
    [STATEMENT_BARRIER_EVENTS, ["_migrations", ...providerTables]],
  );
  const guarded = new Set(tables.rows.filter((row) => row.guarded).map((row) => row.table_name));
  const unguarded = ["_migrations", ...providerTables].filter((table) => !guarded.has(table));
  const ledger = tables.rows.find((row) => row.table_name === "_migrations");
  if (unguarded.length > 0 || !ledger?.row_security || !ledger.forced || !ledger.policy) {
    throw new Error(
      `compatibility barrier is incomplete${unguarded.length ? `: ${unguarded.sort().join(", ")}` : ""}`,
    );
  }
  await verifyRuntimeEpochMarker(db);
}

/** This session carries this build's marker and the database admits it. */
export async function verifyRuntimeEpochMarker(db: Queryable): Promise<void> {
  const result = await db.query<{ marker: string | null; admitted: boolean }>(
    `SELECT current_setting('${RUNTIME_EPOCH_SETTING}', true) AS marker,
            provider_runtime_epoch_admitted() AS admitted`,
  );
  if (result.rows[0]?.marker !== String(RUNTIME_SCHEMA_EPOCH) || result.rows[0].admitted !== true) {
    throw new Error("database sessions do not carry this build's runtime-epoch marker");
  }
}

import pg from "pg";
import type { Queryable } from "../db/queryable.js";
import { withRuntimeEpochMarker } from "../db/runtimeEpoch.js";

export interface ReadOnlySessionOptions {
  connectionString: string;
  ssl?: pg.ClientConfig["ssl"];
  statementTimeoutMs: number;
  connectTimeoutMs: number;
}

/**
 * The SQLSTATE or network code of a failed database step, and nothing
 * else: diagnostics never repeat a driver message, which can quote values,
 * hosts or URLs.
 */
export function databaseErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{2,32}$/.test(code) ? code : "unknown";
}

/**
 * Run `work` in one database session that can only read. The session
 * starts with `default_transaction_read_only` and this build's runtime-epoch
 * marker (so the forced row security of the migration ledger admits the
 * read), and all work runs in a single REPEATABLE READ READ ONLY
 * transaction, one consistent snapshot, that is always rolled back.
 * PostgreSQL itself refuses any INSERT, UPDATE, DELETE, TRUNCATE, DDL,
 * sequence or lock-taking write inside it (SQLSTATE 25006); the epoch
 * marker admits nothing such a transaction could do.
 */
export async function withReadOnlySnapshot<T>(
  options: ReadOnlySessionOptions,
  work: (db: Queryable) => Promise<T>,
): Promise<T> {
  const session = withRuntimeEpochMarker(options.connectionString);
  const client = new pg.Client({
    connectionString: session.connectionString,
    options: `${session.options} -c default_transaction_read_only=on`,
    ssl: options.ssl,
    statement_timeout: options.statementTimeoutMs,
    query_timeout: options.statementTimeoutMs,
    connectionTimeoutMillis: options.connectTimeoutMs,
    application_name: "daski-provider-doctor",
  });
  // A dropped connection surfaces as the failed query, never as a crash.
  client.on("error", () => undefined);
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const mode = await client.query<{ transaction_read_only: string }>("SHOW transaction_read_only");
    if (mode.rows[0]?.transaction_read_only !== "on") {
      throw new Error("the diagnostic transaction is not read-only");
    }
    return await work(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

/** One read under a savepoint, so a refused read leaves the snapshot usable for the next check. */
export async function inSavepoint<T>(db: Queryable, work: () => Promise<T>): Promise<T> {
  await db.query("SAVEPOINT diagnostic_check");
  try {
    const result = await work();
    await db.query("RELEASE SAVEPOINT diagnostic_check");
    return result;
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT diagnostic_check").catch(() => undefined);
    throw error;
  }
}

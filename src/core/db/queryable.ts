import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

/** Database surface shared by Pool and transaction-scoped PoolClient. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export type TransactionClient = PoolClient & Queryable;

/** Roll back a failed transaction and report whether the session is unsafe to reuse. */
export async function rollbackFailedTransaction(
  client: Queryable,
): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return false;
  } catch {
    return true;
  }
}

export async function inTransaction<T>(
  pool: Pool,
  work: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  const client = (await pool.connect()) as TransactionClient;
  let destroyClient = false;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    destroyClient = await rollbackFailedTransaction(client);
    throw error;
  } finally {
    client.release(destroyClient);
  }
}

import type pg from "pg";

type TablePrivilege = "SELECT" | "INSERT" | "UPDATE";

/**
 * The complete runtime-principal allowlist. Every table a migration creates
 * appears here with exactly the statements the HTTP runtime issues; anything
 * else stays revoked. The runtime catalog is read-only: the operator-run
 * importer promotes catalog versions as the migration principal. No runtime
 * path deletes or truncates rows.
 */
export const RUNTIME_TABLE_PRIVILEGES: Readonly<Record<string, readonly TablePrivilege[]>> = {
  provider_transactions: ["SELECT", "INSERT", "UPDATE"],
  standard_evidence_admissions: ["SELECT", "INSERT", "UPDATE"],
  supplier_operations: ["SELECT", "INSERT", "UPDATE"],
  rate_limit_buckets: ["SELECT", "INSERT", "UPDATE"],
  provider_runtime_listing_versions: ["SELECT"],
  provider_quotes: ["SELECT", "INSERT"],
  // Read by the compatibility barrier on every provider write; only
  // migrations change it.
  provider_schema_epoch: ["SELECT"],
  // Only the operator's activation command changes the switch.
  provider_async_admission: ["SELECT"],
  provider_runtime_instances: ["SELECT", "INSERT", "UPDATE"],
};

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

export async function applyRuntimePrivileges(args: {
  migrationPool: pg.Pool;
  runtimeDatabaseUrl: string;
  migrationDatabaseUrl: string;
}): Promise<void> {
  const runtimeRole = decodeURIComponent(new URL(args.runtimeDatabaseUrl).username);
  const migrationRole = decodeURIComponent(new URL(args.migrationDatabaseUrl).username);
  if (!runtimeRole || !migrationRole || runtimeRole === migrationRole) {
    throw new Error("runtime and migration database principals must be distinct");
  }
  const tables = Object.keys(RUNTIME_TABLE_PRIVILEGES);
  const client = await args.migrationPool.connect();
  try {
    const schemaResult = await client.query<{ schema: string }>(
      "SELECT current_schema() AS schema",
    );
    const databaseResult = await client.query<{ database: string }>(
      "SELECT current_database() AS database",
    );
    const schemaName = schemaResult.rows[0]?.schema;
    const databaseName = databaseResult.rows[0]?.database;
    if (!schemaName || !databaseName) throw new Error("database namespace is unavailable");
    const present = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename=ANY($2::text[])",
      [schemaName, tables],
    );
    if (present.rows.length !== tables.length) {
      throw new Error("minimal provider schema is incomplete");
    }
    const schema = quote(schemaName);
    const runtime = quote(runtimeRole);
    const migrator = quote(migrationRole);
    const database = quote(databaseName);
    await client.query("BEGIN");
    await client.query(`ALTER SCHEMA ${schema} OWNER TO ${migrator}`);
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM ${runtime}`);
    await client.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM ${runtime}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${runtime}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${runtime}`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
    for (const [table, privileges] of Object.entries(RUNTIME_TABLE_PRIVILEGES)) {
      await client.query(
        `GRANT ${privileges.join(", ")} ON TABLE ${schema}.${quote(table)} TO ${runtime}`,
      );
    }
    // A table added by a later migration stays inaccessible to the runtime
    // until it is explicitly reviewed into the allowlist above.
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema}
      REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC`);
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema}
      REVOKE ALL PRIVILEGES ON TABLES FROM ${runtime}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

import type pg from "pg";

const TABLES = [
  "provider_transactions",
  "standard_evidence_admissions",
  "supplier_operations",
  "rate_limit_buckets",
] as const;

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
      [schemaName, [...TABLES]],
    );
    if (present.rows.length !== TABLES.length) {
      throw new Error("minimal provider schema is incomplete");
    }
    const schema = quote(schemaName);
    const runtime = quote(runtimeRole);
    const migrator = quote(migrationRole);
    const database = quote(databaseName);
    const tables = TABLES.map((table) => `${schema}.${quote(table)}`).join(", ");
    await client.query("BEGIN");
    await client.query(`ALTER SCHEMA ${schema} OWNER TO ${migrator}`);
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM ${runtime}`);
    await client.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM ${runtime}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${runtime}`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${tables} TO ${runtime}`);
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema}
      REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC`);
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema}
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

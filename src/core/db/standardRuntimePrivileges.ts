import type pg from "pg";

export const RETIRED_STANDARD_RUNTIME_TABLES = [
  "payments",
  "settlement_observations",
  "settlement_dispositions",
  "provider_quotes",
  "reputation_submissions",
] as const;

const quotedIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

export async function applyStandardRuntimePrivileges(args: {
  migrationPool: pg.Pool;
  runtimeDatabaseUrl: string;
  migrationDatabaseUrl: string;
}): Promise<void> {
  const runtimeRole = decodeURIComponent(new URL(args.runtimeDatabaseUrl).username);
  const migrationRole = decodeURIComponent(new URL(args.migrationDatabaseUrl).username);
  if (!runtimeRole || !migrationRole || runtimeRole === migrationRole) {
    throw new Error("standard runtime and migration database roles must be distinct");
  }
  const role = quotedIdentifier(runtimeRole);
  const migrator = quotedIdentifier(migrationRole);
  const client = await args.migrationPool.connect();
  try {
    const schemaResult = await client.query<{ schema: string }>("SELECT current_schema() AS schema");
    const schemaName = schemaResult.rows[0]?.schema;
    if (!schemaName) throw new Error("provider database schema cannot be determined");
    const schema = quotedIdentifier(schemaName);
    const databaseResult = await client.query<{ database: string }>("SELECT current_database() AS database");
    const databaseName = databaseResult.rows[0]?.database;
    if (!databaseName) throw new Error("provider database cannot be determined");
    const database = quotedIdentifier(databaseName);
    const tables = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
      [schemaName],
    );
    const tableNames = new Set(tables.rows.map(({ tablename }) => tablename));
    if (RETIRED_STANDARD_RUNTIME_TABLES.some((table) => !tableNames.has(table))) {
      throw new Error("native provider payment schema is incomplete before standard cutover");
    }
    if (!tableNames.has("standard_dispatch_claims")) {
      throw new Error("standard provider schema is incomplete");
    }
    const registryWriteBoundary = await client.query<{ enabled: boolean; policy: boolean }>(
      `SELECT c.relrowsecurity AS enabled,
              EXISTS(
                SELECT 1 FROM pg_policy p
                 WHERE p.polrelid=c.oid
                   AND p.polname='provider_chain_writes_standard_runtime'
              ) AS policy
         FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname='provider_chain_writes'`,
      [schemaName],
    );
    if (
      registryWriteBoundary.rows[0]?.enabled !== true
      || registryWriteBoundary.rows[0]?.policy !== true
    ) {
      throw new Error("provider standard chain-write row security is not installed");
    }
    const admittedTables = tables.rows.filter(({ tablename }) =>
      tablename !== "_migrations" && tablename !== "_service_migrations" &&
      !(RETIRED_STANDARD_RUNTIME_TABLES as readonly string[]).includes(tablename));
    if (admittedTables.length === 0) throw new Error("provider runtime table allowlist is empty");
    const relations = await client.query<{ relation_name: string; relation_kind: string }>(
      `SELECT c.relname AS relation_name,c.relkind AS relation_kind
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','S')`,
      [schemaName],
    );
    const admittedViews = relations.rows.filter(({ relation_name, relation_kind }) =>
      (relation_kind === "v" || relation_kind === "m") &&
      !(RETIRED_STANDARD_RUNTIME_TABLES as readonly string[]).includes(relation_name));
    const admittedSequences = await client.query<{ sequence_name: string }>(
      `SELECT seq.relname AS sequence_name
         FROM pg_class seq JOIN pg_namespace ns ON ns.oid=seq.relnamespace
        WHERE ns.nspname=$1 AND seq.relkind='S'
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend dep
            JOIN pg_class tbl ON tbl.oid=dep.refobjid
             WHERE dep.objid=seq.oid AND dep.deptype IN ('a','i')
               AND tbl.relname=ANY($2::text[])
          )`,
      [schemaName, [...RETIRED_STANDARD_RUNTIME_TABLES]],
    );
    await client.query("BEGIN");
    await client.query(`ALTER DATABASE ${database} OWNER TO ${migrator}`);
    await client.query(`ALTER SCHEMA ${schema} OWNER TO ${migrator}`);
    for (const relation of relations.rows) {
      const relationType = relation.relation_kind === "S"
        ? "SEQUENCE"
        : relation.relation_kind === "v"
          ? "VIEW"
          : relation.relation_kind === "m"
            ? "MATERIALIZED VIEW"
            : "TABLE";
      await client.query(
        `ALTER ${relationType} ${schema}.${quotedIdentifier(relation.relation_name)} OWNER TO ${migrator}`,
      );
    }
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM ${role}`);
    await client.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM ${role}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    const qualifiedTables = admittedTables
      .map(({ tablename }) => `${schema}.${quotedIdentifier(tablename)}`).join(", ");
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${qualifiedTables} TO ${role}`);
    if (admittedViews.length > 0) {
      const qualifiedViews = admittedViews
        .map(({ relation_name }) => `${schema}.${quotedIdentifier(relation_name)}`).join(", ");
      await client.query(`GRANT SELECT ON TABLE ${qualifiedViews} TO ${role}`);
    }
    if (admittedSequences.rows.length > 0) {
      const qualifiedSequences = admittedSequences.rows
        .map(({ sequence_name }) => `${schema}.${quotedIdentifier(sequence_name)}`).join(", ");
      await client.query(`GRANT USAGE, SELECT, UPDATE ON SEQUENCE ${qualifiedSequences} TO ${role}`);
    }
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema}
      REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC`);
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema}
      REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC`);
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema}
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema}
      GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config.js";
import { logError, logInfo } from "../logger.js";
import { applyRuntimePrivileges } from "./runtimePrivileges.js";
import { withSessionAdvisoryLock } from "./sessionAdvisoryLock.js";
import { databaseTlsConfig } from "./tls.js";

function poolConfig(connectionString: string, applicationName: string): pg.PoolConfig {
  return {
    connectionString,
    ssl: databaseTlsConfig(config.DATABASE_SSL_MODE, config.DATABASE_CA_CERT),
    max: config.DATABASE_POOL_MAX,
    connectionTimeoutMillis: config.DATABASE_ACQUIRE_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    query_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: config.DATABASE_IDLE_TX_TIMEOUT_MS,
    application_name: applicationName,
  };
}

export const pool = new pg.Pool(
  poolConfig(config.DATABASE_URL, config.DATABASE_APPLICATION_NAME),
);
export const migrationPool = new pg.Pool(poolConfig(
  config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL,
  `${config.DATABASE_APPLICATION_NAME}-migrations`.slice(0, 63),
));

pool.on("error", (error) =>
  logError("Unexpected idle PostgreSQL client error", { error: error.message }));
migrationPool.on("error", (error) =>
  logError("Unexpected idle migration client error", { error: error.message }));

let migrationPoolClosed = false;
export async function closeMigrationPool(): Promise<void> {
  if (migrationPoolClosed) return;
  migrationPoolClosed = true;
  await migrationPool.end();
}

export async function checkDatabase(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function runMigrations(): Promise<void> {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  const result = await withSessionAdvisoryLock({
    connect: () => migrationPool.connect(),
    async acquire(client) {
      await client.query(
        "SELECT pg_advisory_lock(hashtextextended('daski-minimal-migrations', 0))",
      );
      return { status: "acquired" as const };
    },
    async unlock(client) {
      const unlocked = await client.query<{ unlocked: boolean }>(
        "SELECT pg_advisory_unlock(hashtextextended('daski-minimal-migrations', 0)) AS unlocked",
      );
      return unlocked.rows[0]?.unlocked === true;
    },
    async work(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
          name TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      const applied = await client.query<{ name: string; checksum: string }>(
        "SELECT name, checksum FROM _migrations",
      );
      const checksums = new Map(applied.rows.map((row) => [row.name, row.checksum]));
      for (const file of files) {
        const sql = readFileSync(join(migrationsDir, file), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        if (checksums.has(file)) {
          if (checksums.get(file) !== checksum) {
            throw new Error(`Applied migration checksum changed: ${file}`);
          }
          continue;
        }
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO _migrations (name, checksum) VALUES ($1, $2)",
            [file, checksum],
          );
          await client.query("COMMIT");
          logInfo(`Migration applied: ${file}`);
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
    },
  });
  if (result.status !== "completed") throw new Error("Migration lock was unavailable");
}

export async function configureRuntimePrivileges(): Promise<void> {
  if (!config.MIGRATION_DATABASE_URL) return;
  await applyRuntimePrivileges({
    migrationPool,
    runtimeDatabaseUrl: config.DATABASE_URL,
    migrationDatabaseUrl: config.MIGRATION_DATABASE_URL,
  });
}

interface RolePosture {
  current_user: string;
  can_create: boolean;
  can_temporary: boolean;
  superuser: boolean;
  create_db: boolean;
  create_role: boolean;
  bypass_rls: boolean;
  owns_schema: boolean;
  owned_tables: number;
}

const ROLE_SQL = `
  SELECT current_user,
         has_schema_privilege(current_user,current_schema(),'CREATE') AS can_create,
         has_database_privilege(current_user,current_database(),'TEMPORARY') AS can_temporary,
         r.rolsuper AS superuser,r.rolcreatedb AS create_db,
         r.rolcreaterole AS create_role,r.rolbypassrls AS bypass_rls,
         pg_get_userbyid(n.nspowner)=current_user AS owns_schema,
         (SELECT count(*)::int FROM pg_class c
           WHERE c.relnamespace=n.oid AND c.relkind IN ('r','p','v','m','S')
             AND pg_get_userbyid(c.relowner)=current_user) AS owned_tables
    FROM pg_roles r JOIN pg_namespace n ON n.nspname=current_schema()
   WHERE r.rolname=current_user
`;

export function assertDatabaseRolePosture(
  runtime: RolePosture,
  migrator: RolePosture,
): void {
  if (runtime.current_user === migrator.current_user) {
    throw new Error("runtime and migration database principals must be distinct");
  }
  if (runtime.can_create || runtime.can_temporary || runtime.owns_schema || runtime.owned_tables > 0) {
    throw new Error("runtime database principal has schema-creation or ownership authority");
  }
  if (!migrator.can_create) throw new Error("migration principal requires schema CREATE");
  for (const [name, role] of [["runtime", runtime], ["migration", migrator]] as const) {
    if (role.superuser || role.create_db || role.create_role || role.bypass_rls) {
      throw new Error(`${name} database principal has cluster-wide privileges`);
    }
  }
}

export async function verifyDatabaseRoleSeparation(): Promise<void> {
  if (!config.MIGRATION_DATABASE_URL) return;
  const [runtime, migrator] = await Promise.all([
    pool.query<RolePosture>(ROLE_SQL),
    migrationPool.query<RolePosture>(ROLE_SQL),
  ]);
  if (!runtime.rows[0] || !migrator.rows[0]) {
    throw new Error("database role verification returned no rows");
  }
  assertDatabaseRolePosture(runtime.rows[0], migrator.rows[0]);
}

export async function failInterruptedTransactions(): Promise<number> {
  const result = await pool.query(
    `UPDATE provider_transactions
        SET state='failed',
            result='{"status":"failed","errorCode":"provider_restarted_during_execution"}'::jsonb,
            completed_at=now()
      WHERE state='executing'`,
  );
  return result.rowCount ?? 0;
}

import { createHash } from "node:crypto";
import { migrationPool } from "../db/pool.js";
import { withSessionAdvisoryLock } from "../db/sessionAdvisoryLock.js";
import { logInfo } from "../logger.js";
import type { ServiceMigration } from "./extensionTypes.js";

/** Run append-only, checksummed migrations for a service or provider extension. */
export async function runModuleMigrations(
  namespace: string,
  migrations: ServiceMigration[],
): Promise<void> {
  const lockKey = `daski-module-migrations:${namespace}`;
  const result = await withSessionAdvisoryLock({
    connect: () => migrationPool.connect(),
    async acquire(client) {
      await client.query(
        "SELECT pg_advisory_lock(hashtextextended($1, 0))",
        [lockKey],
      );
      return { status: "acquired" };
    },
    async unlock(client) {
      const unlocked = await client.query<{ unlocked: boolean }>(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
        [lockKey],
      );
      return unlocked.rows[0]?.unlocked === true;
    },
    async work(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS _service_migrations (
          service_slug TEXT NOT NULL,
          name         TEXT NOT NULL,
          checksum     TEXT NOT NULL,
          applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (service_slug, name)
        )
      `);
      await client.query("ALTER TABLE _service_migrations ADD COLUMN IF NOT EXISTS checksum TEXT");
      const applied = await client.query(
        "SELECT name, checksum FROM _service_migrations WHERE service_slug = $1",
        [namespace],
      );
      const appliedMap = new Map(
        applied.rows.map((row: { name: string; checksum: string | null }) => [
          row.name,
          row.checksum,
        ]),
      );

      for (const migration of migrations) {
        const checksum = createHash("sha256").update(migration.sql, "utf8").digest("hex");
        if (appliedMap.has(migration.name)) {
          const recorded = appliedMap.get(migration.name);
          if (recorded === null) {
            throw new Error(
              `Applied module migration is missing its checksum: ${namespace}/${migration.name}`,
            );
          }
          if (recorded !== checksum) {
            throw new Error(
              `Applied module migration checksum changed: ${namespace}/${migration.name}`,
            );
          }
          continue;
        }
        try {
          await client.query("BEGIN");
          await client.query(migration.sql);
          await client.query(
            "INSERT INTO _service_migrations (service_slug, name, checksum) VALUES ($1, $2, $3)",
            [namespace, migration.name, checksum],
          );
          await client.query("COMMIT");
          logInfo(`Module migration applied: ${namespace}/${migration.name}`);
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
      await client.query("ALTER TABLE _service_migrations ALTER COLUMN checksum SET NOT NULL");
    },
  });
  if (result.status === "busy") {
    throw new Error(`module migration lock unexpectedly reported busy: ${namespace}`);
  }
}

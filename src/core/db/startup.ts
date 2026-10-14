import {
  checkDatabase,
  configureRuntimePrivileges,
  migrationPool,
  pool,
  runMigrations,
  verifyDatabaseRoleSeparation,
} from "./pool.js";
import {
  assertSupportedSchemaEpoch,
  readDatabaseSchemaEpoch,
  verifyCompatibilityBarrier,
  verifyRuntimeEpochMarker,
} from "./runtimeEpoch.js";
import { RUNTIME_TABLE_PRIVILEGES } from "./runtimePrivileges.js";

/**
 * Bring the database to this build's schema before anything else touches it,
 * for the server and the operator commands alike: refuse a newer schema epoch
 * before the first mutation, migrate, prove the legacy-process barrier is in
 * place, apply and verify the runtime grants, and confirm the runtime
 * sessions carry an admitted epoch marker. Nothing here enables async
 * admission or changes a provider row.
 */
export async function prepareProviderDatabase(): Promise<void> {
  if (!(await checkDatabase())) throw new Error("Database unreachable");
  assertSupportedSchemaEpoch(await readDatabaseSchemaEpoch(migrationPool));
  await runMigrations();
  await verifyCompatibilityBarrier(migrationPool, Object.keys(RUNTIME_TABLE_PRIVILEGES));
  await configureRuntimePrivileges();
  await verifyDatabaseRoleSeparation();
  await verifyRuntimeEpochMarker(pool);
}

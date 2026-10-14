import type { Queryable } from "../db/queryable.js";
import { RUNTIME_SCHEMA_EPOCH, verifyCompatibilityBarrier } from "../db/runtimeEpoch.js";
import { RUNTIME_TABLE_PRIVILEGES } from "../db/runtimePrivileges.js";
import { liveRuntimeInstances } from "../runtimeInstance.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { countLegacyExecutions } from "./legacyCutover.js";
import { verifyRetainedObligations } from "./retainedObligations.js";

export interface ActivationCheck {
  name: "compatibility_barrier" | "legacy_executions" | "retained_obligations" | "compatible_workers";
  ok: boolean;
  detail: string;
}

const outcome = async (name: ActivationCheck["name"], work: () => Promise<string>): Promise<ActivationCheck> => {
  try {
    return { name, ok: true, detail: await work() };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : "check failed" };
  }
};

/**
 * Everything async admission requires, checked read-only: the legacy-process
 * barrier is installed at this build's epoch (so no pre-R1 process can run),
 * no pre-R1 execution awaits the cutover, this build can service every
 * retained obligation with its handlers and keys, and every running instance
 * is a compatible external-job worker (at least one). The external-job
 * release extends this list (encryption keys, external-job services).
 */
export async function asyncActivationChecks(
  db: Queryable,
  config: ProviderStandardRailConfig,
): Promise<ActivationCheck[]> {
  return [
    await outcome("compatibility_barrier", async () => {
      await verifyCompatibilityBarrier(db, Object.keys(RUNTIME_TABLE_PRIVILEGES));
      return `schema epoch ${RUNTIME_SCHEMA_EPOCH}, barrier installed`;
    }),
    await outcome("legacy_executions", async () => {
      const legacy = await countLegacyExecutions(db);
      if (legacy > 0) throw new Error(`${legacy} pre-R1 executions await the stop-and-drain cutover`);
      return "none";
    }),
    await outcome("retained_obligations", async () => {
      await verifyRetainedObligations(db, config);
      return "serviceable";
    }),
    await outcome("compatible_workers", async () => {
      const live = await liveRuntimeInstances(db);
      const incompatible = live.filter((instance) =>
        instance.runtimeEpoch !== RUNTIME_SCHEMA_EPOCH || instance.capabilities.externalJobWorker !== true);
      if (live.length === 0) throw new Error("no running instance declares the external-job worker");
      if (incompatible.length > 0) {
        throw new Error(`${incompatible.length} running instances are not compatible external-job workers`);
      }
      return `${live.length} compatible running instances`;
    }),
  ];
}

/**
 * Turn async admission on: one transaction that locks the switch, re-runs
 * every check and enables it only if all pass, recording them as evidence.
 * Returns the checks; `enabled` is true only if this call (or an earlier
 * activation) left it on.
 */
export async function activateAsyncAdmission(
  connect: () => Promise<Queryable & { release(): void }>,
  config: ProviderStandardRailConfig,
): Promise<{ enabled: boolean; checks: ActivationCheck[] }> {
  const client = await connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT enabled FROM provider_async_admission WHERE singleton FOR UPDATE");
    const checks = await asyncActivationChecks(client, config);
    if (checks.some((check) => !check.ok)) {
      await client.query("ROLLBACK");
      return { enabled: false, checks };
    }
    const updated = await client.query<{ enabled: boolean }>(
      `UPDATE provider_async_admission
          SET enabled=true, changed_at=now(), evidence=$1::jsonb
        WHERE singleton AND NOT enabled
        RETURNING enabled`,
      [JSON.stringify({ runtimeEpoch: RUNTIME_SCHEMA_EPOCH, checks })],
    );
    await client.query("COMMIT");
    return { enabled: updated.rowCount === 1 || (await isEnabled(client)), checks };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Turn async admission off. Admitted work is still serviced; no check is needed. */
export async function deactivateAsyncAdmission(db: Queryable): Promise<void> {
  await db.query(
    `UPDATE provider_async_admission SET enabled=false, changed_at=now()
      WHERE singleton AND enabled`,
  );
}

async function isEnabled(db: Queryable): Promise<boolean> {
  const result = await db.query<{ enabled: boolean }>(
    "SELECT enabled FROM provider_async_admission WHERE singleton",
  );
  return result.rows[0]?.enabled === true;
}

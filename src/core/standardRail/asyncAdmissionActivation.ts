import type { Queryable } from "../db/queryable.js";
import { RUNTIME_SCHEMA_EPOCH, verifyCompatibilityBarrier } from "../db/runtimeEpoch.js";
import { RUNTIME_TABLE_PRIVILEGES } from "../db/runtimePrivileges.js";
import { externalJobServicing } from "../externalJobs/servicing.js";
import { liveRuntimeInstances, type LiveRuntimeInstance } from "../runtimeInstance.js";
import type { FieldEncryptionKeyRing } from "../security/fieldEncryption.js";
import { getAllServices } from "../serviceRegistry/registry.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { countLegacyExecutions } from "./legacyCutover.js";
import { verifyRetainedObligations } from "./retainedObligations.js";

export interface ActivationCheck {
  name: "compatibility_barrier" | "legacy_executions" | "retained_obligations" | "compatible_workers"
    | "encryption_keys" | "external_job_services";
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
 * retained obligation with its handlers and keys (unfinished external jobs
 * included), every running instance is a compatible external-job worker (at
 * least one) that declares every adapter version new sales (this build's or
 * any running instance's) or unfinished jobs need, and an active key can
 * seal new jobs' input.
 */
export async function asyncActivationChecks(
  db: Queryable,
  config: ProviderStandardRailConfig,
  keys: FieldEncryptionKeyRing,
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
      await verifyRetainedObligations(db, config, externalJobServicing(getAllServices(), keys));
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
    await outcome("encryption_keys", async () => {
      if (!keys.activeKeyId) throw new Error("PROVIDER_DATA_ENCRYPTION_KEY is not configured");
      return `active key ${keys.activeKeyId}`;
    }),
    await outcome("external_job_services", async () => {
      const live = await liveRuntimeInstances(db);
      const required = await requiredAdapterVersions(db, config.gatewayAudience, live);
      const lacking = live.filter((instance) => [...required].some(([slug, versions]) =>
        [...versions].some((version) => !declaredVersions(instance, slug).includes(version))));
      if (lacking.length > 0) {
        throw new Error(`${lacking.length} running instances cannot resume every required external-job adapter version`);
      }
      const count = [...required.values()].reduce((sum, versions) => sum + versions.size, 0);
      return count === 0 ? "no external-job adapter versions required" : `${count} adapter versions on every instance`;
    }),
  ];
}

/**
 * The external-job adapter versions new sales use (this build's and every
 * running instance's declared ones) and those unfinished jobs of this
 * gateway audience were admitted under.
 */
async function requiredAdapterVersions(
  db: Queryable,
  gatewayAudience: string,
  live: readonly LiveRuntimeInstance[],
): Promise<Map<string, Set<string>>> {
  const required = new Map<string, Set<string>>();
  const add = (slug: string, version: string) => required.set(slug, (required.get(slug) ?? new Set()).add(version));
  for (const service of getAllServices()) {
    if (service.adapter.mode === "external-job") add(service.manifest.slug, service.adapter.version);
  }
  for (const instance of live) {
    const sales = instance.capabilities.externalJobSales;
    if (!sales || typeof sales !== "object" || Array.isArray(sales)) continue;
    for (const [slug, version] of Object.entries(sales as Record<string, unknown>)) {
      if (typeof version === "string") add(slug, version);
    }
  }
  const open = await db.query<{ slug: string; version: string }>(
    `SELECT DISTINCT t.service_slug AS slug, j.adapter_version AS version
       FROM provider_external_jobs j JOIN provider_transactions t ON t.id=j.task_id
      WHERE j.phase IN ('queued','starting','reconciling','polling') AND t.gateway_audience=$1`,
    [gatewayAudience],
  );
  for (const row of open.rows) add(row.slug, row.version);
  return required;
}

function declaredVersions(instance: LiveRuntimeInstance, slug: string): unknown[] {
  const declared = instance.capabilities.externalJobAdapters as Record<string, unknown> | undefined;
  const versions = declared && typeof declared === "object" ? declared[slug] : undefined;
  return Array.isArray(versions) ? versions : [];
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
  keys: FieldEncryptionKeyRing,
): Promise<{ enabled: boolean; checks: ActivationCheck[] }> {
  const client = await connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT enabled FROM provider_async_admission WHERE singleton FOR UPDATE");
    const checks = await asyncActivationChecks(client, config, keys);
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

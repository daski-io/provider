import { randomUUID } from "node:crypto";
import type { Queryable } from "./db/queryable.js";
import { RUNTIME_SCHEMA_EPOCH } from "./db/runtimeEpoch.js";
import { logWarn } from "./logger.js";

/**
 * This process's identity in persisted execution ownership and in the
 * instance registry. A new value per process start: a restarted process owns
 * none of its predecessor's leases, so it can only recover them once they
 * have expired.
 */
export const RUNTIME_INSTANCE_ID = randomUUID();

/** What a running instance declares; async activation reads it. */
export interface RuntimeCapabilities {
  syncExecutionLeases: boolean;
  /** Runs the durable external-job worker (src/core/externalJobs/worker.ts). */
  externalJobWorker: boolean;
  /** The external-job adapter versions it resumes, per service. */
  externalJobAdapters?: Record<string, string[]>;
  /** The external-job adapter version it sells new jobs with, per service. */
  externalJobSales?: Record<string, string>;
}

export const BUILD_CAPABILITIES: Readonly<RuntimeCapabilities> = {
  syncExecutionLeases: true,
  externalJobWorker: true,
};

export const INSTANCE_HEARTBEAT_MS = 15_000;
/** An instance whose heartbeat is older than this is not counted as running. */
export const INSTANCE_LIVENESS_SECONDS = 45;
/**
 * A running instance's external-job worker records its own heartbeat about
 * every 15 seconds (worker.ts); one silent for longer than this (counted
 * from the instance's start before its first) has stopped claiming work.
 */
export const WORKER_HEARTBEAT_MAX_AGE_SECONDS = 60;

export interface LiveRuntimeInstance {
  instanceId: string;
  runtimeEpoch: number;
  revision: string;
  capabilities: Record<string, unknown>;
}

/** Record this process and keep its heartbeat fresh until stopped. */
export async function registerRuntimeInstance(
  db: Queryable,
  revision: string,
  capabilities: RuntimeCapabilities = BUILD_CAPABILITIES,
): Promise<() => Promise<void>> {
  await db.query(
    `INSERT INTO provider_runtime_instances (instance_id,runtime_epoch,revision,capabilities)
     VALUES ($1,$2,$3,$4::jsonb)`,
    [RUNTIME_INSTANCE_ID, RUNTIME_SCHEMA_EPOCH, revision.slice(0, 128) || "unknown", JSON.stringify(capabilities)],
  );
  const timer = setInterval(() => {
    db.query(
      "UPDATE provider_runtime_instances SET heartbeat_at=now() WHERE instance_id=$1 AND stopped_at IS NULL",
      [RUNTIME_INSTANCE_ID],
    ).catch(() => logWarn("Runtime instance heartbeat could not be recorded"));
  }, INSTANCE_HEARTBEAT_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await db.query(
      "UPDATE provider_runtime_instances SET stopped_at=now() WHERE instance_id=$1 AND stopped_at IS NULL",
      [RUNTIME_INSTANCE_ID],
    ).catch(() => undefined);
  };
}

/** Instances with a fresh heartbeat that have not stopped. */
export async function liveRuntimeInstances(db: Queryable): Promise<LiveRuntimeInstance[]> {
  const result = await db.query<{
    instance_id: string; runtime_epoch: number; revision: string; capabilities: Record<string, unknown>;
  }>(
    `SELECT instance_id,runtime_epoch,revision,capabilities FROM provider_runtime_instances
      WHERE stopped_at IS NULL AND heartbeat_at > now() - make_interval(secs => $1)
      ORDER BY started_at,instance_id`,
    [INSTANCE_LIVENESS_SECONDS],
  );
  return result.rows.map((row) => ({
    instanceId: row.instance_id,
    runtimeEpoch: row.runtime_epoch,
    revision: row.revision,
    capabilities: row.capabilities,
  }));
}

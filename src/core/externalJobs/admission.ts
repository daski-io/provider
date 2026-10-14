import type { Queryable } from "../db/queryable.js";
import type { ExternalJobAdapter, JsonRecord } from "../serviceRegistry/types.js";
import type { FieldEncryptionKeyRing } from "../security/fieldEncryption.js";
import { readAsyncAdmission } from "../standardRail/asyncAdmission.js";
import { externalJobIdempotencyKey, type JobOperationIdentity } from "./idempotency.js";
import { jobInputFits, sealJobField } from "./jobCodec.js";
import type { ExternalJobRuntime } from "./runtime.js";

/**
 * Why a funded external-job dispatch cannot be admitted right now: the
 * database switch is off (activation verifies that only compatible workers
 * run) or there is no active key to seal the input with. Both are definite,
 * retryable refusals made before any admission; the gateway retries with a
 * fresh envelope. Product readiness is deliberately not a reason: an
 * admitted job waits for the product instead.
 */
export type ExternalJobAdmissionBlocker = "async_admission_off" | "encryption_key_missing";

export async function externalJobAdmissionBlocker(
  runtime: Pick<ExternalJobRuntime, "keys">,
  db: Queryable,
): Promise<ExternalJobAdmissionBlocker | null> {
  if (!runtime.keys.activeKeyId) return "encryption_key_missing";
  return (await readAsyncAdmission(db)).enabled ? null : "async_admission_off";
}

/** Everything a new job row needs, computed before the claim transaction. */
export interface ExternalJobAdmission {
  serviceSlug: string;
  adapterVersion: string;
  idempotencyKey: string;
  /** The admitted fulfillment window of the dispatched listing version. */
  fulfillmentSeconds: number;
  input: JsonRecord;
}

export function planExternalJob(args: {
  adapter: ExternalJobAdapter;
  identity: JobOperationIdentity;
  fulfillmentSeconds: number;
  input: JsonRecord;
}): ExternalJobAdmission | null {
  if (!jobInputFits(args.input)) return null;
  return {
    serviceSlug: args.identity.serviceSlug,
    adapterVersion: args.adapter.version,
    idempotencyKey: externalJobIdempotencyKey(args.identity),
    fulfillmentSeconds: args.fulfillmentSeconds,
    input: args.input,
  };
}

/**
 * Insert the queued job inside the claim's own transaction, with its input
 * sealed to this task, its stable idempotency key and its overdue
 * threshold (durable acceptance plus the admitted window, database clock).
 * Nothing calls the product here: the worker starts the job after commit.
 */
export async function insertExternalJob(
  client: Queryable,
  ring: FieldEncryptionKeyRing,
  taskId: string,
  job: ExternalJobAdmission,
): Promise<void> {
  const sealed = sealJobField(ring, "input", { taskId, serviceSlug: job.serviceSlug }, job.input);
  await client.query(
    `INSERT INTO provider_external_jobs
       (task_id,adapter_version,idempotency_key,input_ciphertext,input_key_id,
        fulfillment_deadline,next_run_at)
     VALUES ($1,$2,$3,$4,$5,now() + make_interval(secs => $6),now())`,
    [taskId, job.adapterVersion, job.idempotencyKey, sealed.ciphertext, sealed.keyId, job.fulfillmentSeconds],
  );
}

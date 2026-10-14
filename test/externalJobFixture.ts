import type { Queryable } from "../src/core/db/queryable.js";
import type { ExternalJobRuntime } from "../src/core/externalJobs/runtime.js";
import { parseFieldEncryptionKeys, type FieldEncryptionKeyRing } from "../src/core/security/fieldEncryption.js";
import type {
  ExternalJobAdapter,
  ExternalJobContext,
  JsonRecord,
  PollOutcome,
  ServiceModule,
  StartOutcome,
  StartRecovery,
} from "../src/core/serviceRegistry/types.js";
import { echoService } from "./standardRailServiceFixture.js";

/** A test key ring with an active key (and optional previous `id=0x…` keys). */
export const jobKeys = (active = "a1", id = "k1", previous = ""): FieldEncryptionKeyRing =>
  parseFieldEncryptionKeys({ activeKey: `0x${active.repeat(32)}`, activeKeyId: id, previousKeys: previous });

export interface AdapterCall {
  method: "start" | "recoverStart" | "poll";
  context: ExternalJobContext;
  argument: JsonRecord;
}

/** An external-job adapter whose answers each test scripts; it records every call. */
export interface ScriptedAdapter extends ExternalJobAdapter {
  calls: AdapterCall[];
  onStart(context: ExternalJobContext, input: JsonRecord): Promise<StartOutcome>;
  onRecover(context: ExternalJobContext, input: JsonRecord): Promise<StartRecovery>;
  onPoll(context: ExternalJobContext, job: JsonRecord): Promise<PollOutcome>;
}

export function scriptedAdapter(version = "v1", extra: Partial<ExternalJobAdapter> = {}): ScriptedAdapter {
  const adapter: ScriptedAdapter = {
    mode: "external-job",
    version,
    calls: [],
    onStart: async () => ({ kind: "accepted", job: { jobId: "job-1" } }),
    onRecover: async () => ({ kind: "unknown" }),
    onPoll: async () => ({ kind: "pending" }),
    start(context, input) {
      adapter.calls.push({ method: "start", context, argument: input });
      return adapter.onStart(context, input);
    },
    recoverStart(context, input) {
      adapter.calls.push({ method: "recoverStart", context, argument: input });
      return adapter.onRecover(context, input);
    },
    poll(context, job) {
      adapter.calls.push({ method: "poll", context, argument: job });
      return adapter.onPoll(context, job);
    },
    ...extra,
  };
  return adapter;
}

/** The echo test service as an external-job service with a 12-hour window. */
export function jobService(adapter: ExternalJobAdapter, overrides: Partial<ServiceModule> = {}): ServiceModule {
  const base = echoService();
  return {
    ...base,
    adapter,
    skills: [{ ...base.skills[0]!, deadlines: { fulfillmentSeconds: 43_200 } }],
    failureCodes: ["audit_rejected"],
    ...overrides,
  };
}

/** A runtime with the given keys whose worker reports running; it counts wake-ups. */
export function jobRuntime(
  keys: FieldEncryptionKeyRing = jobKeys(),
  running = true,
): ExternalJobRuntime & { wakes: number } {
  const runtime = {
    keys,
    providerAgentId: "1",
    wakes: 0,
    workerRunning: () => running,
    wake: () => { runtime.wakes += 1; },
  };
  return runtime;
}

/** The operator's activation, as the test database owner (tests only). */
export async function setAsyncAdmission(db: Queryable, enabled: boolean): Promise<void> {
  await db.query(
    `UPDATE provider_async_admission SET enabled=$1, changed_at=now(),
            evidence=COALESCE(evidence, '{"test":true}'::jsonb) WHERE singleton`,
    [enabled],
  );
}

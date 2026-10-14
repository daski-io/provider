import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pool } from "../src/core/db/pool.js";
import { openJobField } from "../src/core/externalJobs/jobCodec.js";
import {
  DEFAULT_WORKER_SETTINGS,
  validateWorkerSettings,
  type ExternalJobWorkerSettings,
} from "../src/core/externalJobs/settings.js";
import { ExternalJobWorker } from "../src/core/externalJobs/worker.js";
import type { ServiceModule, ServiceResult } from "../src/core/serviceRegistry/types.js";
import { ResultContracts } from "../src/core/standardRail/resultContracts.js";
import type { ProviderOutcomeConfig } from "../src/core/standardRail/types.js";
import { json, startRailHarness, type RailHarness } from "./dispatchHarness.js";
import { jobKeys, jobRuntime, jobService, scriptedAdapter, setAsyncAdmission, type ScriptedAdapter } from "./externalJobFixture.js";
import { dispatchOrder, quoteOrder } from "./gatewayOrderFixture.js";
import { gatewayLifecycleCall, LIFECYCLE_HEADERS } from "./gatewayLifecycleWire.js";
import type { ProviderAnswer } from "./gatewayWire.js";

export const jobPayerKey = `0x${"7c".repeat(32)}` as Hex;
export const jobPayer = privateKeyToAccount(jobPayerKey).address;

/** The echo listing's complete completed result. */
export const echoCompleted: ServiceResult = {
  status: "completed",
  message: "Echo completed.",
  artifacts: [{ name: "echo_result", mimeType: "application/json", data: { message: "hello" } }],
};

/** Fast, deterministic worker settings: a three-second lease and no jitter. */
export const TEST_WORKER_SETTINGS: ExternalJobWorkerSettings = validateWorkerSettings({
  ...DEFAULT_WORKER_SETTINGS,
  callTimeoutMs: 1_000,
  leaseSeconds: 3,
  leaseRenewMs: 500,
  jitterRatio: 0,
  idleTickMs: 50,
});

export interface AdmittedJob {
  orderId: string;
  taskId: string;
  dispatchHash: Hex;
  body: Record<string, unknown>;
}

/**
 * An HTTP provider with one external-job service, and an external-job
 * worker on the same PostgreSQL database that tests drive round by round.
 * Time is the database clock: a test fast-forwards a job by making its
 * persisted next run (or lease expiry) due now, never by sleeping hours.
 */
export interface JobHarness {
  rail: RailHarness;
  adapter: ScriptedAdapter;
  worker: ExternalJobWorker;
  admit(request?: Record<string, unknown>): Promise<AdmittedJob>;
  /** One worker round: claim what is due and step it to its next write. */
  round(worker?: ExternalJobWorker): Promise<number>;
  newWorker(settings?: Partial<ExternalJobWorkerSettings>): ExternalJobWorker;
  job(taskId: string): Promise<Record<string, any>>;
  claim(taskId: string): Promise<Record<string, any>>;
  /** Make the job's next run due now. */
  due(taskId: string): Promise<void>;
  /** Expire the job's lease, as if its holder crashed. */
  expireLease(taskId: string): Promise<void>;
  /** Seconds from now until the job's next run. */
  waitSeconds(taskId: string): Promise<number>;
  reference(taskId: string): Promise<Record<string, unknown>>;
  status(job: AdmittedJob): Promise<Record<string, unknown>>;
  lifecycle(job: AdmittedJob, action: "status" | "artifact"): Promise<ProviderAnswer>;
  close(): Promise<void>;
}

export async function startJobHarness(options: {
  version?: string;
  outcome?: Partial<ProviderOutcomeConfig>;
  settings?: Partial<ExternalJobWorkerSettings>;
  service?: Partial<ServiceModule>;
  retention?: number;
} = {}): Promise<JobHarness> {
  const adapter = scriptedAdapter(options.version ?? `t${randomUUID().slice(0, 8)}`, {
    ...(options.retention === undefined ? {} : { idempotencyRetentionSeconds: options.retention }),
  });
  const keys = jobKeys();
  const rail = await startRailHarness({
    service: jobService(adapter, options.service),
    externalJobs: jobRuntime(keys),
    outcome: {
      listingManifestHash: `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}` as Hex,
      maxOpenOrders: 1_000,
      ...options.outcome,
    },
  });
  await setAsyncAdmission(pool, true);
  const newWorker = (settings: Partial<ExternalJobWorkerSettings> = {}) => new ExternalJobWorker({
    owner: randomUUID(),
    settings: validateWorkerSettings({ ...TEST_WORKER_SETTINGS, ...options.settings, ...settings }),
    keys,
    resultContracts: new ResultContracts(rail.config),
    random: () => 0.5,
  });
  const worker = newWorker();
  const row = async (sql: string, taskId: string) => (await pool.query(sql, [taskId])).rows[0] as Record<string, any>;
  return {
    rail,
    adapter,
    worker,
    newWorker,
    async admit(request = { message: "hello" }) {
      const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome, payer: jobPayer, request });
      const dispatched = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config });
      const answer = json(await rail.post("/standard-rail/dispatch", dispatched.body));
      if (answer.state !== "submitted") throw new Error(`external job was not admitted: ${JSON.stringify(answer)}`);
      return {
        orderId: order.orderId, taskId: String(answer.taskId), dispatchHash: dispatched.dispatchHash, body: dispatched.body,
      };
    },
    round: (chosen = worker) => chosen.runDue(),
    job: (taskId) => row("SELECT * FROM provider_external_jobs WHERE task_id=$1", taskId),
    claim: (taskId) => row("SELECT * FROM provider_transactions WHERE id=$1", taskId),
    async due(taskId) {
      await pool.query(
        "UPDATE provider_external_jobs SET next_run_at=now(), revision=revision + 1 WHERE task_id=$1",
        [taskId],
      );
    },
    async expireLease(taskId) {
      await pool.query(
        `UPDATE provider_external_jobs SET lease_expires_at=now() - interval '1 second', revision=revision + 1
          WHERE task_id=$1 AND lease_token IS NOT NULL`,
        [taskId],
      );
    },
    async waitSeconds(taskId) {
      const result = await pool.query<{ wait: string }>(
        "SELECT extract(epoch FROM next_run_at - now())::float AS wait FROM provider_external_jobs WHERE task_id=$1",
        [taskId],
      );
      return Math.round(Number(result.rows[0]?.wait));
    },
    async reference(taskId) {
      const job = await row("SELECT * FROM provider_external_jobs WHERE task_id=$1", taskId);
      return openJobField(keys, "reference", { taskId, serviceSlug: "dummy" }, {
        ciphertext: job.job_reference_ciphertext, keyId: job.job_reference_key_id,
      });
    },
    async status(job) {
      return json(await rail.status(job.orderId, job.dispatchHash));
    },
    async lifecycle(job, action) {
      return rail.post("/standard-rail/lifecycle", await gatewayLifecycleCall({
        orderId: job.orderId, providerTaskId: job.taskId, action, payer: jobPayer,
      }), LIFECYCLE_HEADERS);
    },
    async close() {
      await worker.stop();
      await rail.close();
      await pool.query(
        `UPDATE provider_external_jobs SET lease_expires_at=now() - interval '1 second', revision=revision + 1
          WHERE lease_expires_at > now()`,
      );
    },
  };
}

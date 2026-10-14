import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_job_admission_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import { externalJobIdempotencyKey } from "../src/core/externalJobs/idempotency.js";
import { openJobField } from "../src/core/externalJobs/jobCodec.js";
import { json, startRailHarness, type RailHarness } from "./dispatchHarness.js";
import {
  jobKeys,
  jobRuntime,
  jobService,
  scriptedAdapter,
  setAsyncAdmission,
  type ScriptedAdapter,
} from "./externalJobFixture.js";
import { dispatchOrder, quoteOrder } from "./gatewayOrderFixture.js";
import {
  acceptLifecycleAnswerAsGateway,
  classifyLifecycleRefusal,
  gatewayLifecycleCall,
  LIFECYCLE_HEADERS,
} from "./gatewayLifecycleWire.js";
import { acceptDispatchSnapshotAsGateway, classifyDispatchAnswer } from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";
import { echoResultSchema } from "./standardRailOutcomeFixture.js";

const payerKey = `0x${"6b".repeat(32)}` as Hex;
const payer = privateKeyToAccount(payerKey).address;

const claimRows = async (orderId: string) => (await pool.query<{ id: string; state: string; lease: string | null }>(
  `SELECT id, state, execution_lease_token AS lease FROM provider_transactions WHERE order_id=$1`, [orderId],
)).rows;
const jobRow = async (taskId: string) => (await pool.query<Record<string, unknown>>(
  `SELECT *, extract(epoch FROM fulfillment_deadline - accepted_at)::int AS window_seconds,
          next_run_at <= now() AS due
     FROM provider_external_jobs WHERE task_id=$1`, [taskId],
)).rows[0];

// L03/L-T02/L-T17: a valid external-job dispatch commits one claim and one
// queued job and answers before any product call; nothing reaches the
// product when admission fails; a later readiness outage queues the funded
// order instead of refusing it.
describePostgres("external-job admission against PostgreSQL", () => {
  let database: DisposableDatabase;
  let rail: RailHarness;
  let adapter: ScriptedAdapter;
  let runtime: ReturnType<typeof jobRuntime>;

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_job_admission", undefined, target.name);
    await runMigrations();
    await closeMigrationPool();
  });

  beforeEach(async () => {
    adapter = scriptedAdapter();
    runtime = jobRuntime();
    rail = await startRailHarness({ service: jobService(adapter), externalJobs: runtime });
    await setAsyncAdmission(pool, true);
  });

  afterEach(async () => {
    await rail?.close();
  });

  afterAll(async () => {
    await Promise.race([
      pool.end().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await database?.drop();
  });

  const admit = async (harness = rail) => {
    const order = await quoteOrder({ quotes: harness.quotes, outcome: harness.outcome, payer });
    const dispatched = await dispatchOrder({ order, outcome: harness.outcome, config: harness.config });
    return { order, dispatched, answer: await harness.post("/standard-rail/dispatch", dispatched.body) };
  };

  it("commits one queued job before any product call and answers submitted", async () => {
    const { order, dispatched, answer } = await admit();
    expect(classifyDispatchAnswer(answer)).toBe("accepted");
    const accepted = await acceptDispatchSnapshotAsGateway({ value: json(answer), dispatchHash: dispatched.dispatchHash });
    expect(accepted.body.state).toBe("submitted");
    expect(accepted.attestation).toBeNull();
    const [claim] = await claimRows(order.orderId);
    expect(claim).toMatchObject({ state: "external_job", lease: null });
    const job = await jobRow(claim!.id);
    expect(job).toMatchObject({
      phase: "queued", adapter_version: "v1", revision: "0", first_start_attempt_at: null,
      journal_operation_id: null, job_reference_ciphertext: null, input_key_id: "k1",
      window_seconds: rail.outcome.fulfillmentSeconds, due: true,
    });
    // The stable key is the one derivable from the admitted identity alone.
    expect(job!.idempotency_key).toBe(externalJobIdempotencyKey({
      environment: "testnet", chainId: 84532, providerAgentId: "1", gatewayAudience: "https://gateway.example",
      orderId: order.orderId, serviceSlug: "dummy", skillId: "echo",
    }));
    // The input is stored only sealed to this job row.
    expect(String(job!.input_ciphertext)).toMatch(/^daski:v1:/);
    expect(String(job!.input_ciphertext)).not.toContain("hello");
    expect(openJobField(jobKeys(), "input", { taskId: claim!.id, serviceSlug: "dummy" }, {
      ciphertext: String(job!.input_ciphertext), keyId: "k1",
    })).toEqual(order.request);
    expect(adapter.calls).toEqual([]);
    expect(runtime.wakes).toBe(1);

    // Exact replays, status polls and buyer reads see the same single job.
    const replay = await rail.post("/standard-rail/dispatch", dispatched.body);
    await expect(acceptDispatchSnapshotAsGateway({ value: json(replay), dispatchHash: dispatched.dispatchHash }))
      .resolves.toMatchObject({ body: { taskId: claim!.id, state: "submitted" } });
    const status = await rail.status(order.orderId, dispatched.dispatchHash);
    expect(json(status)).toMatchObject({ taskId: claim!.id, state: "submitted" });
    const read = async (action: "status" | "artifact") => rail.post("/standard-rail/lifecycle", await gatewayLifecycleCall({
      orderId: order.orderId, providerTaskId: claim!.id, action, payer,
    }), LIFECYCLE_HEADERS);
    await expect(acceptLifecycleAnswerAsGateway({
      value: json(await read("status")), action: "status", orderId: order.orderId,
      providerTaskId: claim!.id, resultSchema: echoResultSchema(),
    })).resolves.toMatchObject({ body: { state: "submitted" } });
    expect(classifyLifecycleRefusal("artifact", await read("artifact"))).toBe("ARTIFACT_NOT_AVAILABLE");
    expect(await claimRows(order.orderId)).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM provider_external_jobs")).rows[0].n).toBeGreaterThan(0);
    expect(adapter.calls).toEqual([]);
  });

  it("refuses before admission while async admission is off or no key can seal the input", async () => {
    const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome, payer });
    await setAsyncAdmission(pool, false);
    let dispatched = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config });
    let answer = await rail.post("/standard-rail/dispatch", dispatched.body);
    expect([answer.status, json(answer)]).toEqual([503, { error: "dispatch_rejected", reason: "service_unavailable" }]);
    await setAsyncAdmission(pool, true);
    const unkeyed = await startRailHarness({
      service: jobService(adapter), externalJobs: jobRuntime({ activeKeyId: null, keys: new Map() }),
    });
    try {
      dispatched = await dispatchOrder({ order, outcome: unkeyed.outcome, config: unkeyed.config });
      answer = await unkeyed.post("/standard-rail/dispatch", dispatched.body);
      expect(json(answer)).toEqual({ error: "dispatch_rejected", reason: "service_unavailable" });
    } finally {
      await unkeyed.close();
    }
    expect(await claimRows(order.orderId)).toEqual([]);
    // The gateway's next fresh envelope is admitted once both hold again.
    dispatched = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config });
    answer = await rail.post("/standard-rail/dispatch", dispatched.body);
    expect(json(answer)).toMatchObject({ state: "submitted" });
    expect(adapter.calls).toEqual([]);
  });

  it("calls nothing when the admission transaction fails", async () => {
    await pool.query(`CREATE FUNCTION test_refuse_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected job insert failure'; END $$`);
    await pool.query(`CREATE TRIGGER test_refuse_job BEFORE INSERT ON provider_external_jobs
      FOR EACH ROW EXECUTE FUNCTION test_refuse_job()`);
    let order: Awaited<ReturnType<typeof admit>>["order"];
    try {
      const admitted = await admit();
      order = admitted.order;
      // Nothing committed: a definite refusal the gateway retries freshly.
      expect(json(admitted.answer)).toEqual({ error: "dispatch_rejected", reason: "service_unavailable" });
    } finally {
      await pool.query("DROP TRIGGER test_refuse_job ON provider_external_jobs");
      await pool.query("DROP FUNCTION test_refuse_job()");
    }
    expect(await claimRows(order!.orderId)).toEqual([]);
    expect(adapter.calls).toEqual([]);
    expect(runtime.wakes).toBe(0);
  });

  it("queues a funded job during a product outage and never re-runs request readiness", async () => {
    const readiness = vi.fn(async () => ({ ready: true as const }));
    await rail.close();
    rail = await startRailHarness({
      service: jobService(adapter, { requestReadiness: readiness }), externalJobs: runtime,
    });
    const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome, payer });
    expect(readiness).toHaveBeenCalledTimes(1);
    rail.state.ready = false;
    const dispatched = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config });
    const answer = await rail.post("/standard-rail/dispatch", dispatched.body);
    expect(json(answer)).toMatchObject({ state: "submitted" });
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(adapter.calls).toEqual([]);
  });

  it("declines a request before payment without creating a quote, a job or a call", async () => {
    await rail.close();
    rail = await startRailHarness({
      service: jobService(adapter, {
        requestReadiness: async () => ({
          ready: false, fieldErrors: [{ path: "message", rule: "not_auditable", message: "Not auditable." }],
        }),
      }),
      externalJobs: runtime,
    });
    const before = (await pool.query("SELECT count(*)::int AS n FROM provider_quotes")).rows[0].n;
    await expect(quoteOrder({ quotes: rail.quotes, outcome: rail.outcome, payer })).rejects.toThrow(/request_invalid/);
    expect((await pool.query("SELECT count(*)::int AS n FROM provider_quotes")).rows[0].n).toBe(before);
    expect(adapter.calls).toEqual([]);
  });

  it("counts queued jobs against new quotes, never against funded dispatches", async () => {
    await rail.close();
    rail = await startRailHarness({
      service: jobService(adapter), externalJobs: runtime, outcome: { maxOpenOrders: 1, listingManifestHash: `0x${"5c".repeat(32)}` as Hex },
    });
    const first = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome, payer });
    const second = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome, payer });
    for (const order of [first, second]) {
      const dispatched = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config });
      expect(json(await rail.post("/standard-rail/dispatch", dispatched.body))).toMatchObject({ state: "submitted" });
    }
    await expect(quoteOrder({ quotes: rail.quotes, outcome: rail.outcome, payer })).rejects.toThrow(/capacity/);
  });
});

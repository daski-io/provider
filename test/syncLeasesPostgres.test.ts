import type { Hex } from "viem";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_leases_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import { RUNTIME_INSTANCE_ID } from "../src/core/runtimeInstance.js";
import type { ServiceResult, TaskContext } from "../src/core/serviceRegistry/types.js";
import { sweepAbandonedSyncExecutions, type SyncLeaseTiming } from "../src/core/standardRail/syncLease.js";
import { beginSupplierOperation, getSupplierOperation } from "../src/core/suppliers/operationJournal.js";
import { json, startRailHarness, type RailHarness } from "./dispatchHarness.js";
import { dispatchOrder, quoteOrder } from "./gatewayOrderFixture.js";
import { acceptDispatchSnapshotAsGateway, classifyDispatchAnswer } from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";

const completed: ServiceResult = { status: "completed", message: "Echo completed." };

/** An adapter that blocks until released or aborted, recording its context. */
function gatedAdapter(onStart?: (context: TaskContext) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen: { context?: TaskContext; started: Promise<void>; aborted: boolean } = {
    started: Promise.resolve(), aborted: false,
  };
  let markStarted!: () => void;
  seen.started = new Promise<void>((resolve) => { markStarted = resolve; });
  const adapter = {
    async execute(context: TaskContext): Promise<ServiceResult> {
      seen.context = context;
      await onStart?.(context);
      markStarted();
      await Promise.race([gate, new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => { seen.aborted = true; resolve(); }, { once: true });
      })]);
      return completed;
    },
  };
  return { adapter, release, seen };
}

const lease = async (taskId: string) => (await pool.query<{
  owner: string; token: string; expires: Date; state: string; result: unknown;
}>(
  `SELECT execution_owner AS owner, execution_lease_token AS token,
          execution_lease_expires_at AS expires, state, result
     FROM provider_transactions WHERE id=$1`,
  [taskId],
)).rows[0]!;

// L-T06 (synchronous part): persisted execution ownership with an expiring,
// renewed lease. Startup and other processes never fail a live call; a stale
// holder cannot finalize; only an expired lease is failed by policy.
describePostgres("synchronous execution leases against PostgreSQL", () => {
  let database: DisposableDatabase;
  let rail: RailHarness | null = null;

  async function start(adapter: ReturnType<typeof gatedAdapter>["adapter"], timing: SyncLeaseTiming) {
    rail = await startRailHarness({ service: { adapter }, lease: timing });
    const order = await quoteOrder({ quotes: rail.quotes, outcome: rail.outcome });
    const dispatched = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config });
    const answer = rail.post("/standard-rail/dispatch", dispatched.body);
    // A failed assertion must not leave the pending call unobserved.
    answer.catch(() => undefined);
    return { order, dispatched, answer };
  }

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_leases", undefined, target.name);
    await runMigrations();
    await closeMigrationPool();
  });

  afterEach(async () => {
    await rail?.close();
    rail = null;
  });

  afterAll(async () => {
    await Promise.race([
      pool.end().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await database?.drop();
  });

  it("owns and renews a live call that no restart or overlapping process sweeps", async () => {
    const gated = gatedAdapter();
    const { dispatched, answer } = await start(gated.adapter, { leaseSeconds: 3, renewMs: 200, sweepMs: 1_000 });
    await gated.seen.started;
    const taskId = gated.seen.context!.taskId;
    const claimed = await lease(taskId);
    expect(claimed).toMatchObject({ owner: RUNTIME_INSTANCE_ID, state: "executing" });
    // Another process's live call, admitted under its own lease.
    await pool.query(
      `INSERT INTO provider_transactions (
         id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
         service_slug,skill_id,listing_manifest_hash,state,dispatch_valid_before,
         execution_owner,execution_lease_token,execution_lease_expires_at
       ) VALUES ('task-other-process','https://gateway.example','ord_other_process',
         decode(repeat('5a',32),'hex'),decode(repeat('5b',32),'hex'),decode(repeat('33',32),'hex'),
         '0x1111111111111111111111111111111111111111','dummy','echo',decode(repeat('44',32),'hex'),
         'executing',now() + interval '5 minutes',gen_random_uuid(),gen_random_uuid(),
         now() + interval '1 minute')`,
    );
    // What a starting process does first: sweep. Neither live call is touched.
    await expect(sweepAbandonedSyncExecutions()).resolves.toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect((await lease(taskId)).expires.getTime()).toBeGreaterThan(claimed.expires.getTime());
    gated.release();
    const result = await answer;
    expect(classifyDispatchAnswer(result)).toBe("accepted");
    await expect(acceptDispatchSnapshotAsGateway({ value: json(result), dispatchHash: dispatched.dispatchHash }))
      .resolves.toMatchObject({ body: { state: "completed" } });
    expect((await lease("task-other-process")).state).toBe("executing");
  });

  it("refuses a stale holder's result and fails the abandoned call with its mutation left ambiguous", async () => {
    const gated = gatedAdapter(async (context) => {
      await beginSupplierOperation({
        serviceId: "dummy", transactionId: context.taskId, opKey: `op-${context.taskId}`, kind: "probe",
      });
    });
    // The lease is never renewed, so it expires while the call runs.
    const { order, dispatched, answer } = await start(gated.adapter, { leaseSeconds: 1, renewMs: 60_000, sweepMs: 1_000 });
    await gated.seen.started;
    const taskId = gated.seen.context!.taskId;
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    gated.release();
    const stale = await answer;
    // The result was not written; the answer is deliberately ambiguous.
    expect([stale.status, stale.text]).toEqual([503, ""]);
    expect(await lease(taskId)).toMatchObject({ state: "executing", result: null });
    await expect(sweepAbandonedSyncExecutions()).resolves.toEqual([taskId]);
    expect(await lease(taskId)).toMatchObject({
      state: "failed", result: { status: "failed", errorCode: "provider_execution_abandoned" },
    });
    const journal = await getSupplierOperation("dummy", `op-${taskId}`);
    expect(journal?.state).toBe("intent");
    const status = json(await rail!.status(order.orderId, dispatched.dispatchHash as Hex));
    expect(status.state).toBe("failed");
  });

  it("aborts the call as soon as a renewal finds the lease lost", async () => {
    const gated = gatedAdapter();
    const { answer } = await start(gated.adapter, { leaseSeconds: 1, renewMs: 1_400, sweepMs: 1_000 });
    await gated.seen.started;
    const taskId = gated.seen.context!.taskId;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(sweepAbandonedSyncExecutions()).resolves.toEqual([taskId]);
    const lost = await answer;
    expect(gated.seen.aborted).toBe(true);
    // The holder writes nothing more; the gateway reconciles through status,
    // which serves the durable failure.
    expect([lost.status, lost.text]).toEqual([503, ""]);
    expect(await lease(taskId)).toMatchObject({
      state: "failed", result: { status: "failed", errorCode: "provider_execution_abandoned" },
    });
  });
});

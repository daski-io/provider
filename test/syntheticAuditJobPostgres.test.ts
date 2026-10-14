import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_synthetic_audit_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import { ExternalJobWorker } from "../src/core/externalJobs/worker.js";
import { getSupplierOperation } from "../src/core/suppliers/operationJournal.js";
import { ResultContracts } from "../src/core/standardRail/resultContracts.js";
import { AUDIT_FULFILLMENT_SECONDS, AUDIT_PRICE_ATOMIC } from "../src/services/synthetic-audit/config.js";
import { createSyntheticAuditService } from "../src/services/synthetic-audit/index.js";
import { FakeAuditUpstream } from "../src/services/synthetic-audit/upstream.js";
import { json, startRailHarness, type RailHarness } from "./dispatchHarness.js";
import { jobPayer, TEST_WORKER_SETTINGS } from "./externalJobHarness.js";
import { jobKeys, jobRuntime, setAsyncAdmission } from "./externalJobFixture.js";
import { dispatchOrder, quoteOrder } from "./gatewayOrderFixture.js";
import { acceptLifecycleAnswerAsGateway, gatewayLifecycleCall, LIFECYCLE_HEADERS } from "./gatewayLifecycleWire.js";
import { acceptDispatchSnapshotAsGateway } from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";

// L-T03 (with L-T04) against PostgreSQL and the actual scheduler: the
// synthetic eight-hour audit under its 12-hour policy, its first start
// response lost, completes through ordinary signed status and artifact
// reads. Only the product's fake clock moves eight hours; the provider waits
// on persisted schedules, never on an open request.
describePostgres("synthetic eight-hour audit against PostgreSQL", () => {
  let database: DisposableDatabase;
  let rail: RailHarness;
  let fakeNow = 1_800_000_000;
  const upstream = new FakeAuditUpstream(() => fakeNow);
  const module = createSyntheticAuditService({ chainId: 84532, clock: () => fakeNow, upstream });

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_synthetic_audit", undefined, target.name);
    await runMigrations();
    await closeMigrationPool();
    rail = await startRailHarness({
      service: module,
      externalJobs: jobRuntime(jobKeys()),
      outcome: {
        outcomeId: "audit", serviceSlug: "synthetic-audit", skillId: "audit",
        listingManifestHash: `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}` as Hex,
        requestSchema: module.skills[0]!.inputSchema as never,
        resultSchema: module.skills[0]!.resultSchema,
        fulfillmentSeconds: AUDIT_FULFILLMENT_SECONDS,
        fixedGrossAmount: AUDIT_PRICE_ATOMIC,
      },
    });
    await setAsyncAdmission(pool, true);
  });

  afterAll(async () => {
    await rail?.close();
    await Promise.race([
      pool.end().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await database?.drop();
  });

  it("completes the audit through signed reads after a lost start answer and eight fake hours", async () => {
    const worker = new ExternalJobWorker({
      owner: randomUUID(), settings: TEST_WORKER_SETTINGS, keys: jobKeys(),
      resultContracts: new ResultContracts(rail.config), random: () => 0.5,
    });
    const order = await quoteOrder({
      quotes: rail.quotes, outcome: rail.outcome, payer: jobPayer,
      request: { description: "Audit the sample onboarding flow" },
    });
    const dispatched = await dispatchOrder({ order, outcome: rail.outcome, config: rail.config });
    const startedAt = Date.now();
    const answer = await rail.post("/standard-rail/dispatch", dispatched.body);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    const admitted = await acceptDispatchSnapshotAsGateway({ value: json(answer), dispatchHash: dispatched.dispatchHash });
    expect(admitted.body.state).toBe("submitted");
    expect(upstream.submissions).toBe(0);
    const taskId = String(admitted.body.taskId);
    const job = async () => (await pool.query("SELECT * FROM provider_external_jobs WHERE task_id=$1", [taskId])).rows[0];
    const due = () => pool.query(
      "UPDATE provider_external_jobs SET next_run_at=now(), revision=revision + 1 WHERE task_id=$1", [taskId],
    );
    const waitSeconds = async () => Number((await pool.query(
      "SELECT extract(epoch FROM next_run_at - now())::float AS wait FROM provider_external_jobs WHERE task_id=$1",
      [taskId],
    )).rows[0].wait);
    const row = await job();
    expect(Number((await pool.query(
      "SELECT extract(epoch FROM fulfillment_deadline - accepted_at)::int AS window FROM provider_external_jobs WHERE task_id=$1",
      [taskId],
    )).rows[0].window)).toBe(12 * 3_600);

    // The product creates the audit, but its answer to start is lost.
    upstream.loseNextSubmitResponse = true;
    await worker.runDue();
    expect((await job()).phase).toBe("reconciling");
    expect(upstream.submissions).toBe(1);
    await due();
    await worker.runDue();
    expect((await job()).phase).toBe("polling");

    let polls = 0;
    while ((await job()).phase === "polling") {
      // The product's clock moves by exactly the wait the worker persisted.
      fakeNow += Math.round(await waitSeconds());
      await due();
      await worker.runDue();
      polls += 1;
      expect(polls).toBeLessThan(40);
      const status = json(await rail.status(order.orderId, dispatched.dispatchHash));
      expect(["working", "completed"]).toContain(status.state);
    }
    expect(polls).toBe(16);
    expect(upstream.submissions).toBe(1);

    const status = await acceptDispatchSnapshotAsGateway({
      value: json(await rail.status(order.orderId, dispatched.dispatchHash)), dispatchHash: dispatched.dispatchHash,
    });
    expect(status.body.state).toBe("completed");
    const artifact = await acceptLifecycleAnswerAsGateway({
      value: json(await rail.post("/standard-rail/lifecycle", await gatewayLifecycleCall({
        orderId: order.orderId, providerTaskId: taskId, action: "artifact", payer: jobPayer,
      }), LIFECYCLE_HEADERS)),
      action: "artifact", orderId: order.orderId, providerTaskId: taskId,
      resultSchema: module.skills[0]!.resultSchema,
      storedTerminal: {
        taskId, state: "completed", resultHash: status.attestation!.resultHash, completedAt: status.attestation!.completedAt,
      },
    });
    expect(artifact.body.result).toMatchObject({
      status: "completed", artifacts: [{ name: "audit_report", data: { findings: [{ severity: "medium" }, { severity: "low" }] } }],
    });
    expect(await getSupplierOperation("synthetic-audit", row.idempotency_key))
      .toMatchObject({ state: "confirmed", external_job_task_id: taskId, result: null });
    expect((await job()).overdue_at).toBeNull();
  }, 120_000);
});

import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_job_worker_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import { boundedFetch } from "../src/core/security/outboundHttp.js";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { sweepAbandonedSyncExecutions } from "../src/core/standardRail/syncLease.js";
import { json } from "./dispatchHarness.js";
import { echoCompleted, startJobHarness, type JobHarness } from "./externalJobHarness.js";
import { acceptLifecycleAnswerAsGateway } from "./gatewayLifecycleWire.js";
import { acceptDispatchSnapshotAsGateway } from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";
import { echoResultSchema } from "./standardRailOutcomeFixture.js";

const never = () => new Promise<never>(() => undefined);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// L04/L06 against PostgreSQL: the worker drives each job through its
// persisted phases with fenced leases; every non-definitive start answer
// reconciles; reads never call the product.
describePostgres("external-job worker against PostgreSQL", () => {
  let database: DisposableDatabase;
  let h: JobHarness | null = null;

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_job_worker", undefined, target.name);
    await runMigrations();
    await closeMigrationPool();
  });

  afterEach(async () => {
    await h?.close();
    h = null;
  });

  afterAll(async () => {
    await Promise.race([
      pool.end().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await database?.drop();
  });

  it("starts, polls and completes a job, served through ordinary signed reads", async () => {
    h = await startJobHarness();
    const harness = h;
    harness.adapter.onStart = async () => ({ kind: "accepted", job: { jobId: "up-1" }, pollAfterSeconds: 120 });
    let polls = 0;
    harness.adapter.onPoll = async () => (++polls < 3 ? { kind: "pending" } : { kind: "terminal", result: echoCompleted });
    const job = await harness.admit();
    expect(await harness.round()).toBe(1);
    expect(await harness.job(job.taskId)).toMatchObject({
      phase: "polling", start_attempts: 1, failure_count: 0, lease_token: null, job_reference_key_id: "k1",
    });
    expect(await harness.waitSeconds(job.taskId)).toBe(120);
    expect(await harness.reference(job.taskId)).toEqual({ jobId: "up-1" });
    expect(await harness.status(job)).toMatchObject({ state: "working" });
    // Nothing is due: the wait is persisted, no request stays open.
    expect(await harness.round()).toBe(0);
    for (const expected of ["polling", "polling", "completed"]) {
      await harness.due(job.taskId);
      expect(await harness.round()).toBe(1);
      expect((await harness.job(job.taskId)).phase).toBe(expected);
      if (expected === "polling") expect(await harness.waitSeconds(job.taskId)).toBe(60);
    }
    const [claim, finished] = [await harness.claim(job.taskId), await harness.job(job.taskId)];
    expect(claim).toMatchObject({ state: "completed", result: echoCompleted });
    expect(`0x${claim.result_hash.toString("hex")}`).toBe(canonicalHash(echoCompleted));
    expect(finished).toMatchObject({
      input_ciphertext: null, job_reference_ciphertext: null, result_candidate_ciphertext: null, lease_token: null,
    });
    expect(finished.result_hash).toEqual(claim.result_hash);
    const status = await acceptDispatchSnapshotAsGateway({ value: await harness.status(job), dispatchHash: job.dispatchHash });
    expect(status.attestation?.resultHash).toBe(canonicalHash(echoCompleted));
    const artifact = await acceptLifecycleAnswerAsGateway({
      value: json(await harness.lifecycle(job, "artifact")), action: "artifact", orderId: job.orderId,
      providerTaskId: job.taskId, resultSchema: echoResultSchema(), storedTerminal: {
        taskId: job.taskId, state: "completed", resultHash: status.attestation!.resultHash,
        completedAt: status.attestation!.completedAt,
      },
    });
    expect(artifact.body.result).toEqual(echoCompleted);
    // One start and three polls, all under the job's stable key.
    expect(harness.adapter.calls.map((entry) => entry.method)).toEqual(["start", "poll", "poll", "poll"]);
    expect(new Set(harness.adapter.calls.map((entry) => entry.context.idempotencyKey)))
      .toEqual(new Set([finished.idempotency_key]));
    expect(harness.adapter.calls[0]!.argument).toEqual({ message: "hello" });
    expect(harness.adapter.calls[1]!.argument).toEqual({ jobId: "up-1" });
    expect(harness.adapter.calls[0]!.context.firstStartAttemptAt).toBeGreaterThan(0);
  });

  it("reconciles every throw, abort, timeout or invalid start, and writes no late answer", async () => {
    h = await startJobHarness();
    const harness = h;
    let late: (() => void) | null = null;
    const variants: Array<[string, () => Promise<unknown>]> = [
      ["throw", async () => { throw new Error("upstream said it definitely failed"); }],
      ["no job", async () => ({ kind: "accepted" })],
      ["unknown kind", async () => ({ kind: "maybe" })],
      ["scalar job", async () => ({ kind: "accepted", job: "job-7" })],
      ["unreviewed issue", async () => ({ kind: "ambiguous", issue: { code: "teapot" } })],
      ["extra key", async () => ({ kind: "accepted", job: { jobId: "j" }, note: "x" })],
      ["not a result", async () => ({ kind: "terminal", result: { status: "probably" } })],
      ["timeout", () => new Promise((resolve) => {
        late = () => resolve({ kind: "accepted", job: { jobId: "late" } });
      })],
    ];
    for (const [label, answer] of variants) {
      harness.adapter.onStart = answer as never;
      const job = await harness.admit();
      expect(await harness.round(), label).toBe(1);
      const row = await harness.job(job.taskId);
      expect(row, label).toMatchObject({ phase: "reconciling", job_reference_ciphertext: null, start_attempts: 1 });
      expect(String(row.last_error_code), label).toMatch(/^start\./);
      expect(await harness.status(job), label).toMatchObject({ state: "working" });
    }
    // The timed-out call answers after its outcome was decided: nothing is written.
    const before = await pool.query("SELECT task_id, revision FROM provider_external_jobs ORDER BY task_id");
    (late as unknown as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await pool.query("SELECT task_id, revision FROM provider_external_jobs ORDER BY task_id")).rows)
      .toEqual(before.rows);
    expect(harness.adapter.calls.filter((entry) => entry.method === "start")).toHaveLength(variants.length);
  });

  it("recovers a start whose response was lost before its job reference was persisted", async () => {
    h = await startJobHarness();
    const harness = h;
    const upstream = new Map<string, string>();
    harness.adapter.onStart = async (context) => {
      upstream.set(context.idempotencyKey, `up-${upstream.size + 1}`);
      // The process dies right after the product accepted: the lease lapses
      // before the handoff can commit.
      await harness.expireLease(context.taskId);
      return { kind: "accepted", job: { jobId: upstream.get(context.idempotencyKey)! } };
    };
    harness.adapter.onRecover = async (context) => {
      const found = upstream.get(context.idempotencyKey);
      return found ? { kind: "accepted", job: { jobId: found } } : { kind: "unknown" };
    };
    const job = await harness.admit();
    await harness.round();
    expect(await harness.job(job.taskId)).toMatchObject({ phase: "starting", job_reference_ciphertext: null });
    // Lost HTTP responses and exact replays never start a second audit.
    expect(json(await harness.rail.post("/standard-rail/dispatch", job.body))).toMatchObject({ state: "working" });
    expect(await harness.status(job)).toMatchObject({ state: "working" });
    await harness.round();
    expect(await harness.job(job.taskId)).toMatchObject({ phase: "reconciling", last_error_code: "start.interrupted" });
    await harness.round();
    expect(await harness.job(job.taskId)).toMatchObject({ phase: "polling", reconciliation_count: 0 });
    expect(await harness.reference(job.taskId)).toEqual({ jobId: "up-1" });
    expect(upstream.size).toBe(1);
    expect(harness.adapter.calls.map((entry) => entry.method)).toEqual(["start", "recoverStart"]);
  });

  it("never sends a start its lease cannot outlast, and reconciles the recorded intent", async () => {
    h = await startJobHarness({ settings: { callTimeoutMs: 1_000, leaseSeconds: 3, leaseRenewMs: 1_000 } });
    const harness = h;
    const job = await harness.admit();
    const { idempotency_key: key } = await harness.job(job.taskId);
    // The start intent waits behind the journal lock until the lease could
    // no longer cover a call and a renewal: it commits, the call is not sent.
    const blocker = await pool.connect();
    try {
      await blocker.query("SELECT pg_advisory_lock(hashtext('dummy'), hashtext($1))", [key]);
      const round = harness.round();
      await sleep(2_800);
      await blocker.query("SELECT pg_advisory_unlock(hashtext('dummy'), hashtext($1))", [key]);
      await round;
    } finally {
      blocker.release();
    }
    expect(harness.adapter.calls).toEqual([]);
    expect(await harness.job(job.taskId)).toMatchObject({ phase: "starting", start_attempts: 1 });
    // Like any interrupted start, the recorded intent is reconciled.
    await harness.expireLease(job.taskId);
    await harness.round();
    expect(await harness.job(job.taskId)).toMatchObject({ phase: "reconciling", last_error_code: "start.interrupted" });
    expect(harness.adapter.calls.map((entry) => entry.method)).toEqual([]);
  });

  it("delays a queued job while the product is down instead of starting or failing it", async () => {
    let ready = false;
    h = await startJobHarness({ service: { readiness: async () => ready } });
    const harness = h;
    const job = await harness.admit();
    await harness.round();
    expect(await harness.job(job.taskId)).toMatchObject({
      phase: "queued", failure_count: 1, last_error_code: "product_unavailable", first_start_attempt_at: null,
    });
    expect(await harness.waitSeconds(job.taskId)).toBe(15);
    expect(harness.adapter.calls).toEqual([]);
    ready = true;
    await harness.due(job.taskId);
    await harness.round();
    expect((await harness.job(job.taskId)).phase).toBe("polling");
  });

  it("reads a waiting job cheaply: no product call, no write", async () => {
    h = await startJobHarness();
    const harness = h;
    const job = await harness.admit();
    await harness.round();
    const before = await harness.job(job.taskId);
    const calls = harness.adapter.calls.length;
    for (let read = 0; read < 25; read += 1) {
      expect(await harness.status(job)).toMatchObject({ state: "working" });
      expect(json(await harness.lifecycle(job, "status"))).toMatchObject({ state: "working" });
    }
    expect(harness.adapter.calls).toHaveLength(calls);
    expect((await harness.job(job.taskId)).revision).toBe(before.revision);
    // Synchronous lease sweeping never touches an external job.
    await expect(sweepAbandonedSyncExecutions()).resolves.toEqual([]);
  });

  it("aborts a slow upstream response body at the call limit and retries without a second job", async () => {
    let closed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => { closed = resolve; });
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{\"kind\":");
      res.on("close", () => closed());
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      h = await startJobHarness();
      const harness = h;
      harness.adapter.onPoll = async (context) => {
        const response = await boundedFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/job`, {
          signal: context.signal,
        });
        return response.json();
      };
      const job = await harness.admit();
      await harness.round();
      await harness.due(job.taskId);
      const startedAt = Date.now();
      await harness.round();
      await connectionClosed;
      expect(Date.now() - startedAt).toBeLessThan(2_500);
      expect(await harness.job(job.taskId)).toMatchObject({
        phase: "polling", failure_count: 1, last_error_code: "poll.timeout",
      });
      expect(harness.adapter.calls.filter((entry) => entry.method === "start")).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("times out a call whose adapter ignores the abort signal", async () => {
    h = await startJobHarness();
    const harness = h;
    harness.adapter.onStart = never;
    const job = await harness.admit();
    const startedAt = Date.now();
    await harness.round();
    expect(Date.now() - startedAt).toBeLessThan(2_500);
    expect(await harness.job(job.taskId)).toMatchObject({ phase: "reconciling", last_error_code: "start.timeout" });
  });
});

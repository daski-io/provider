import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_job_overlap_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import type { ServiceResult } from "../src/core/serviceRegistry/types.js";
import { echoCompleted, startJobHarness, type JobHarness } from "./externalJobHarness.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A call that stays open until the test answers it. */
function gate<T>() {
  let answer!: (value: T) => void;
  const opened = new Promise<T>((resolve) => { answer = resolve; });
  return { opened, answer };
}

// L-T06 against PostgreSQL: a restart in any phase, or a compatible
// process overlapping this one, keeps exactly one upstream job; a stale
// worker cannot commit or finalize; the call limit holds across processes.
describePostgres("external-job restarts and overlapping workers against PostgreSQL", () => {
  let database: DisposableDatabase;
  let h: JobHarness | null = null;

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_job_overlap", undefined, target.name);
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

  it("resumes a job in every phase after its process stops, with one upstream job", async () => {
    h = await startJobHarness({ settings: { callTimeoutMs: 5_000, leaseSeconds: 15, leaseRenewMs: 500 } });
    const harness = h;
    const upstream = new Map<string, string>();
    harness.adapter.onRecover = async (context) => {
      const found = upstream.get(context.idempotencyKey);
      return found ? { kind: "accepted", job: { jobId: found } } : { kind: "unknown" };
    };
    const job = await harness.admit();
    // queued: a process that admitted the job and stopped has started nothing.
    const crashedStart = gate<unknown>();
    harness.adapter.onStart = async (context) => {
      upstream.set(context.idempotencyKey, "up-only");
      return crashedStart.opened as never;
    };
    const first = harness.round();
    await vi.waitFor(() => expect(harness.adapter.calls).toHaveLength(1));
    // starting: the process dies inside the call; a new process may take the
    // job only once its lease has expired, and then reconciles.
    const restarted = harness.newWorker();
    expect(await harness.round(restarted)).toBe(0);
    await harness.expireLease(job.taskId);
    await harness.round(restarted);
    expect(await harness.job(job.taskId)).toMatchObject({ phase: "reconciling", last_error_code: "start.interrupted" });
    // reconciling: recovery by the original key finds the original job.
    await harness.round(restarted);
    expect((await harness.job(job.taskId)).phase).toBe("polling");
    // The dead process's call finally answers: it cannot write anything.
    const before = await harness.job(job.taskId);
    crashedStart.answer({ kind: "accepted", job: { jobId: "late-duplicate" } });
    await first;
    expect(await harness.job(job.taskId)).toMatchObject({ revision: before.revision, phase: "polling" });
    expect(await harness.reference(job.taskId)).toEqual({ jobId: "up-only" });
    // polling: another restart polls the same job and completes it.
    harness.adapter.onPoll = async () => ({ kind: "terminal", result: echoCompleted });
    await harness.due(job.taskId);
    await harness.round(harness.newWorker());
    expect(await harness.claim(job.taskId)).toMatchObject({ state: "completed" });
    expect(harness.adapter.calls.filter((entry) => entry.method === "start")).toHaveLength(1);
    expect(upstream.size).toBe(1);
  });

  it("lets no stale worker finalize a job another worker took over", async () => {
    h = await startJobHarness({ settings: { callTimeoutMs: 5_000, leaseSeconds: 15, leaseRenewMs: 500 } });
    const harness = h;
    const job = await harness.admit();
    await harness.round();
    const stalePoll = gate<unknown>();
    harness.adapter.onPoll = () => stalePoll.opened as never;
    await harness.due(job.taskId);
    const stale = harness.round();
    await vi.waitFor(() => expect(harness.adapter.calls.filter((entry) => entry.method === "poll")).toHaveLength(1));
    await harness.expireLease(job.taskId);
    const current: ServiceResult = echoCompleted;
    harness.adapter.onPoll = async () => ({ kind: "terminal", result: current });
    await harness.round(harness.newWorker());
    const frozen = await harness.claim(job.taskId);
    expect(frozen).toMatchObject({ state: "completed", result: current });
    // The stale holder's own terminal answer arrives afterwards.
    stalePoll.answer({ kind: "terminal", result: { status: "failed", errorCode: "audit_rejected" } });
    await stale;
    expect(await harness.claim(job.taskId)).toEqual(frozen);
  });

  it("claims a due job once when two compatible processes overlap", async () => {
    h = await startJobHarness();
    const harness = h;
    const jobs = [await harness.admit(), await harness.admit(), await harness.admit()];
    const other = harness.newWorker();
    const [mine, theirs] = await Promise.all([harness.round(), harness.round(other)]);
    expect(mine + theirs).toBe(3);
    expect(harness.adapter.calls.filter((entry) => entry.method === "start")).toHaveLength(3);
    expect(new Set(harness.adapter.calls.map((entry) => entry.context.taskId)))
      .toEqual(new Set(jobs.map((job) => job.taskId)));
    for (const job of jobs) expect((await harness.job(job.taskId)).phase).toBe("polling");
  });

  it("holds the call limit across processes sharing the database", async () => {
    h = await startJobHarness({ settings: { maxConcurrentCalls: 2, callTimeoutMs: 5_000, leaseSeconds: 15 } });
    const harness = h;
    const open = gate<unknown>();
    let inFlight = 0;
    let peak = 0;
    harness.adapter.onStart = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await open.opened;
      inFlight -= 1;
      return { kind: "accepted", job: { jobId: "j" } };
    };
    for (let count = 0; count < 3; count += 1) await harness.admit();
    const other = harness.newWorker();
    const rounds = [harness.round(), harness.round(other)];
    await sleep(300);
    expect(await harness.round(harness.newWorker())).toBe(0);
    expect(peak).toBe(2);
    open.answer(undefined);
    expect((await Promise.all(rounds)).reduce((sum, value) => sum + value, 0)).toBe(2);
    // The freed slot takes the third job.
    expect(await harness.round()).toBe(1);
    expect(peak).toBe(2);
  });
});

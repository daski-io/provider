import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_job_recovery_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import type { ExternalJobContext } from "../src/core/serviceRegistry/types.js";
import { echoCompleted, startJobHarness, type JobHarness } from "./externalJobHarness.js";
import { acceptDispatchSnapshotAsGateway } from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";

const ambiguousStart = async () => ({ kind: "ambiguous" as const, issue: { code: "timeout" as const } });
const starts = (h: JobHarness) => h.adapter.calls.filter((entry) => entry.method === "start");
const epoch = (value: Date | null) => value === null ? null : Math.floor(value.getTime() / 1_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// L-T05, L-T07 and L-T08 against PostgreSQL with fake upstream answers:
// recovery never starts on an unproven absence, same-key replay only inside
// its persisted horizon, pending polls never spend the failure budget, and
// the deadline fails only work that never started.
describePostgres("external-job recovery, backoff and deadlines against PostgreSQL", () => {
  let database: DisposableDatabase;
  let h: JobHarness | null = null;

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_job_recovery", undefined, target.name);
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

  /** Admit a job whose start is ambiguous, leaving it reconciling. */
  async function ambiguousJob(harness: JobHarness) {
    harness.adapter.onStart = ambiguousStart;
    const job = await harness.admit();
    await harness.round();
    expect((await harness.job(job.taskId)).phase).toBe("reconciling");
    return job;
  }

  it("never starts again on an empty eventually consistent lookup, backing off its recovery", async () => {
    h = await startJobHarness({ retention: 86_400 });
    const harness = h;
    const job = await ambiguousJob(harness);
    // The product's search lags: it finds nothing yet, which proves nothing.
    harness.adapter.onRecover = async () => ({ kind: "unknown" });
    const waits: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await harness.due(job.taskId);
      await harness.round();
      waits.push(await harness.waitSeconds(job.taskId));
    }
    expect(waits).toEqual([15, 30, 60, 120, 240]);
    expect(await harness.job(job.taskId)).toMatchObject({ phase: "reconciling", reconciliation_count: 5 });
    expect(starts(harness)).toHaveLength(1);
  });

  it("replays the original key only inside the persisted horizon of a declared retention", async () => {
    // Without a declared retention, a replay verdict is not acted on.
    h = await startJobHarness();
    let job = await ambiguousJob(h);
    h.adapter.onRecover = async () => ({ kind: "safe-to-start", basis: "idempotent-replay" });
    await h.due(job.taskId);
    await h.round();
    expect(await h.job(job.taskId)).toMatchObject({
      phase: "reconciling", last_error_code: "recover.restart_not_permitted", start_attempts: 1,
    });
    expect(starts(h)).toHaveLength(1);
    await h.close();

    // Inside the horizon: the same key and the same, unextended horizon.
    h = await startJobHarness({ retention: 86_400 });
    job = await ambiguousJob(h);
    const first = await h.job(job.taskId);
    h.adapter.onRecover = async () => ({ kind: "safe-to-start", basis: "idempotent-replay" });
    h.adapter.onStart = async () => ({ kind: "accepted", job: { jobId: "replayed" } });
    await h.due(job.taskId);
    await h.round();
    const replayed = await h.job(job.taskId);
    expect(replayed).toMatchObject({ phase: "polling", start_attempts: 2 });
    expect(replayed.first_start_attempt_at).toEqual(first.first_start_attempt_at);
    expect(replayed.idempotency_valid_before).toEqual(first.idempotency_valid_before);
    expect(epoch(replayed.idempotency_valid_before)! - epoch(replayed.first_start_attempt_at)!).toBe(86_400);
    const [original, replay] = starts(h).map((entry) => entry.context as ExternalJobContext);
    expect(replay!.idempotencyKey).toBe(original!.idempotencyKey);
    expect(replay!.firstStartAttemptAt).toBe(original!.firstStartAttemptAt);
    expect(replay!.idempotencyValidBefore).toBe(original!.idempotencyValidBefore);
    await h.close();

    // Too close to the horizon for the call and its margin: unknown, until
    // an authoritative lookup resolves the original operation.
    h = await startJobHarness({ retention: 100 });
    job = await ambiguousJob(h);
    h.adapter.onRecover = async () => ({ kind: "safe-to-start", basis: "idempotent-replay" });
    await h.due(job.taskId);
    await h.round();
    expect(await h.job(job.taskId)).toMatchObject({ phase: "reconciling", last_error_code: "recover.restart_not_permitted" });
    h.adapter.onRecover = async () => ({ kind: "accepted", job: { jobId: "found-by-key" } });
    await h.due(job.taskId);
    await h.round();
    expect((await h.job(job.taskId)).phase).toBe("polling");
    expect(await h.reference(job.taskId)).toEqual({ jobId: "found-by-key" });
    expect(starts(h)).toHaveLength(1);
  });

  it("starts again on proven absence, but never once a start is known to have executed", async () => {
    h = await startJobHarness();
    const job = await ambiguousJob(h);
    h.adapter.onRecover = async () => ({ kind: "safe-to-start", basis: "authoritative-absence" });
    h.adapter.onStart = async () => ({ kind: "terminal", result: { status: "completed", message: 7 } } as never);
    await h.due(job.taskId);
    await h.round();
    // The second start answered with a result the contract refuses: the
    // start executed, so recovery may only retrieve, never start again.
    expect(await h.job(job.taskId)).toMatchObject({
      phase: "reconciling", start_attempts: 2, result_diagnostic: "result_schema_mismatch",
    });
    expect((await h.job(job.taskId)).result_candidate_ciphertext).toMatch(/^daski:v1:/);
    await h.due(job.taskId);
    await h.round();
    expect(await h.job(job.taskId)).toMatchObject({ start_attempts: 2, last_error_code: "recover.restart_not_permitted" });
    expect(starts(h)).toHaveLength(2);
  });

  it("keeps hundreds of pending polls off the failure budget and backs off failures without a new job", async () => {
    h = await startJobHarness();
    const harness = h;
    const job = await harness.admit();
    await harness.round();
    for (let poll = 0; poll < 300; poll += 1) {
      await harness.due(job.taskId);
      await harness.round();
    }
    expect(await harness.job(job.taskId)).toMatchObject({
      phase: "polling", failure_count: 0, last_error_code: null, reconciliation_count: 0,
    });
    expect(await harness.waitSeconds(job.taskId)).toBe(60);
    const answers: Array<() => Promise<unknown>> = [
      async () => ({ kind: "retry", issue: { code: "rate_limited", retryAfterSeconds: 90 } }),
      async () => { throw new Error("socket hang up"); },
      async () => ({ kind: "retry", issue: { code: "upstream_unavailable" } }),
      () => new Promise(() => undefined),
      async () => ({ kind: "retry", issue: { code: "invalid_response" } }),
      async () => "<html>bad gateway</html>",
    ];
    const waits: number[] = [];
    for (const answer of answers) {
      harness.adapter.onPoll = answer as never;
      await harness.due(job.taskId);
      await harness.round();
      waits.push(await harness.waitSeconds(job.taskId));
    }
    // The upstream minimum delay is a floor; then 15 s doubling per failure.
    expect(waits).toEqual([90, 30, 60, 120, 240, 480]);
    expect(await harness.job(job.taskId)).toMatchObject({ phase: "polling", failure_count: 6 });
    harness.adapter.onPoll = async () => ({ kind: "pending" });
    await harness.due(job.taskId);
    await harness.round();
    expect(await harness.job(job.taskId)).toMatchObject({ failure_count: 0, last_error_code: null });
    expect(starts(harness)).toHaveLength(1);
  }, 120_000);

  it("fails at the deadline only work that never started", async () => {
    let ready = false;
    h = await startJobHarness({ outcome: { fulfillmentSeconds: 2 }, service: { readiness: async () => ready } });
    const job = await h.admit();
    await h.round();
    expect((await h.job(job.taskId)).phase).toBe("queued");
    await sleep(2_100);
    ready = true;
    await h.due(job.taskId);
    await h.round();
    expect(await h.claim(job.taskId)).toMatchObject({
      state: "failed", result: { status: "failed", errorCode: "provider_job_not_started" },
    });
    expect(await h.job(job.taskId)).toMatchObject({ phase: "failed", first_start_attempt_at: null });
    expect(h.adapter.calls).toEqual([]);
    const status = await acceptDispatchSnapshotAsGateway({ value: await h.status(job), dispatchHash: job.dispatchHash });
    expect(status.body.state).toBe("failed");
  });

  it("keeps started and ambiguous work nonterminal past the deadline and accepts a late completion", async () => {
    h = await startJobHarness({ outcome: { fulfillmentSeconds: 2 } });
    const harness = h;
    const ambiguous = await ambiguousJob(harness);
    harness.adapter.onStart = async () => ({ kind: "accepted", job: { jobId: "slow" } });
    const polling = await harness.admit();
    await harness.round();
    expect((await harness.job(polling.taskId)).phase).toBe("polling");
    await sleep(2_100);
    // Past the deadline no start is attempted, even on proven absence.
    harness.adapter.onRecover = async () => ({ kind: "safe-to-start", basis: "authoritative-absence" });
    for (const job of [ambiguous, polling]) await harness.due(job.taskId);
    await harness.round();
    for (const job of [ambiguous, polling]) {
      const row = await harness.job(job.taskId);
      expect(row.overdue_at).not.toBeNull();
      expect(row.phase).toBe(job === ambiguous ? "reconciling" : "polling");
      // The bounded overdue cadence, five minutes by default.
      expect(await harness.waitSeconds(job.taskId)).toBe(300);
      expect(await harness.status(job)).toMatchObject({ state: "working" });
    }
    expect(starts(harness)).toHaveLength(2);
    // A late result is still verified and frozen once, with no new start.
    harness.adapter.onRecover = async () => ({ kind: "terminal", result: echoCompleted });
    harness.adapter.onPoll = async () => ({ kind: "terminal", result: echoCompleted });
    for (const job of [ambiguous, polling]) await harness.due(job.taskId);
    await harness.round();
    for (const job of [ambiguous, polling]) {
      expect(await harness.claim(job.taskId)).toMatchObject({ state: "completed", result: echoCompleted });
      expect((await harness.job(job.taskId)).overdue_at).not.toBeNull();
    }
    expect(starts(harness)).toHaveLength(2);
  });
});

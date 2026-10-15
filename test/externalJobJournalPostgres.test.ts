import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_job_journal_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import { replayStartJournal, START_JOURNAL_KIND } from "../src/core/externalJobs/journalHandoff.js";
import { redactSensitiveValue } from "../src/core/security/redaction.js";
import {
  fingerprintRequest,
  getSupplierOperation,
  runSupplierOperation,
} from "../src/core/suppliers/operationJournal.js";
import { startJobHarness, type JobHarness } from "./externalJobHarness.js";
import { jobKeys } from "./externalJobFixture.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";

const bearerReference = {
  jobId: "aud-1",
  resultUrl: "https://audit.example/v1/jobs/aud-1/report?token=bearer-secret-value",
};

// L04/L-T18: core's start journal confirms in the one fenced transaction
// that persists the encrypted job reference; a failure between the two
// writes rolls both back; a replay follows the job-row reference and never
// consumes a redacted placeholder as the handle.
describePostgres("external-job start journal handoff against PostgreSQL", () => {
  let database: DisposableDatabase;
  let h: JobHarness | null = null;

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_job_journal", undefined, target.name);
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

  const journalOf = async (taskId: string) => {
    const job = await h!.job(taskId);
    return { job, op: await getSupplierOperation("dummy", job.idempotency_key) };
  };

  it("confirms the journal by naming the job row that holds the encrypted reference", async () => {
    h = await startJobHarness();
    const harness = h;
    harness.adapter.onStart = async () => ({ kind: "accepted", job: bearerReference });
    const admitted = await harness.admit();
    await harness.round();
    const { job, op } = await journalOf(admitted.taskId);
    expect(job.phase).toBe("polling");
    expect(op).toMatchObject({
      id: job.journal_operation_id, service_id: "dummy", transaction_id: admitted.taskId,
      op_key: job.idempotency_key, kind: START_JOURNAL_KIND, state: "confirmed",
      external_job_task_id: admitted.taskId, result: null, error_code: null, attempts: 1,
    });
    // The bearer reference exists only sealed in the job row.
    expect(String(job.job_reference_ciphertext)).not.toMatch(/bearer-secret-value|audit\.example/);
    expect(JSON.stringify(op)).not.toMatch(/bearer-secret-value|audit\.example/);
    // A replay follows the reference and decrypts it whole; the generic
    // journal's redacted replay would have destroyed the handle.
    await expect(replayStartJournal(pool, jobKeys(), { serviceSlug: "dummy", idempotencyKey: job.idempotency_key }))
      .resolves.toEqual({ state: "confirmed", reference: bearerReference, finished: false });
    expect(redactSensitiveValue(bearerReference)).not.toEqual(bearerReference);
    const execute = vi.fn(async () => ({ jobId: "second" }));
    await expect(runSupplierOperation({
      serviceId: "dummy", transactionId: admitted.taskId, opKey: job.idempotency_key, kind: START_JOURNAL_KIND,
      request: { taskId: admitted.taskId, idempotencyKey: job.idempotency_key },
      execute, reconcile: async () => null,
    })).rejects.toThrow(/job row holds the outcome/);
    expect(execute).not.toHaveBeenCalled();
    expect(fingerprintRequest({ taskId: admitted.taskId, idempotencyKey: job.idempotency_key }))
      .toBe(op!.request_fingerprint);
  });

  it("rolls both writes back when the handoff fails between them, then recovers by the original key", async () => {
    h = await startJobHarness();
    const harness = h;
    const upstream = new Map<string, Record<string, unknown>>();
    harness.adapter.onStart = async (context) => {
      upstream.set(context.idempotencyKey, bearerReference);
      return { kind: "accepted", job: bearerReference };
    };
    harness.adapter.onRecover = async (context) => {
      const found = upstream.get(context.idempotencyKey);
      return found ? { kind: "accepted", job: found } : { kind: "unknown" };
    };
    const admitted = await harness.admit();
    // The reference write succeeds; the journal confirmation after it fails.
    await pool.query(`CREATE FUNCTION test_refuse_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected journal confirmation failure'; END $$`);
    await pool.query(`CREATE TRIGGER test_refuse_confirmation BEFORE UPDATE ON supplier_operations
      FOR EACH ROW WHEN (NEW.state = 'confirmed') EXECUTE FUNCTION test_refuse_confirmation()`);
    try {
      await harness.round();
    } finally {
      await pool.query("DROP TRIGGER test_refuse_confirmation ON supplier_operations");
      await pool.query("DROP FUNCTION test_refuse_confirmation()");
    }
    let state = await journalOf(admitted.taskId);
    expect(state.job).toMatchObject({ phase: "starting", job_reference_ciphertext: null });
    expect(state.op).toMatchObject({ state: "intent", external_job_task_id: null, result: null });
    // The process holding the lease is gone: the start is reconciled with
    // its original key, never repeated.
    await harness.expireLease(admitted.taskId);
    await harness.round();
    state = await journalOf(admitted.taskId);
    expect(state.job.phase).toBe("reconciling");
    expect(state.op).toMatchObject({ state: "ambiguous", error_code: "execute.ambiguous" });
    await harness.round();
    state = await journalOf(admitted.taskId);
    expect(state.job.phase).toBe("polling");
    expect(state.op).toMatchObject({ state: "confirmed", external_job_task_id: admitted.taskId, result: null });
    expect(await harness.reference(admitted.taskId)).toEqual(bearerReference);
    expect(harness.adapter.calls.map((entry) => entry.method)).toEqual(["start", "recoverStart"]);
    expect(upstream.size).toBe(1);
  });

  it("keeps one journal identity across an ambiguous start and a proven restart", async () => {
    h = await startJobHarness();
    const harness = h;
    harness.adapter.onStart = async () => ({ kind: "ambiguous", issue: { code: "timeout" } });
    const admitted = await harness.admit();
    await harness.round();
    const first = await journalOf(admitted.taskId);
    expect(first.op).toMatchObject({ state: "ambiguous", error_code: "execute.transport", attempts: 2 });
    harness.adapter.onRecover = async () => ({ kind: "safe-to-start", basis: "authoritative-absence" });
    harness.adapter.onStart = async () => ({ kind: "accepted", job: { jobId: "second-try" } });
    await harness.settle(admitted.taskId);
    await harness.due(admitted.taskId);
    await harness.round();
    const second = await journalOf(admitted.taskId);
    expect(second.job).toMatchObject({ phase: "polling", start_attempts: 2 });
    expect(second.op).toMatchObject({ id: first.op!.id, state: "confirmed", attempts: 3 });
    const keys = harness.adapter.calls.filter((entry) => entry.method === "start").map((entry) => entry.context.idempotencyKey);
    expect(new Set(keys)).toEqual(new Set([first.job.idempotency_key]));
  });

  it("never starts again once the journal confirmed that the start executed", async () => {
    h = await startJobHarness();
    const harness = h;
    // The start answered at once, with a result the contract refuses: the
    // start is confirmed, the job keeps retrieving.
    harness.adapter.onStart = async () => ({ kind: "terminal", result: { status: "completed", message: 5 } } as never);
    const admitted = await harness.admit();
    await harness.round();
    const { job, op } = await journalOf(admitted.taskId);
    expect(job).toMatchObject({ phase: "reconciling", result_diagnostic: "result_schema_mismatch" });
    expect(op).toMatchObject({ state: "confirmed", external_job_task_id: admitted.taskId });
    await expect(replayStartJournal(pool, jobKeys(), { serviceSlug: "dummy", idempotencyKey: job.idempotency_key }))
      .resolves.toEqual({ state: "confirmed", reference: null, finished: false });
    harness.adapter.onRecover = async () => ({ kind: "safe-to-start", basis: "authoritative-absence" });
    await harness.due(admitted.taskId);
    await harness.round();
    expect(await harness.job(admitted.taskId)).toMatchObject({
      phase: "reconciling", start_attempts: 1, last_error_code: "recover.restart_not_permitted",
    });
    expect(harness.adapter.calls.filter((entry) => entry.method === "start")).toHaveLength(1);
  });
});

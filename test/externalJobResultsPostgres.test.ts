import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_job_results_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import { openJobField } from "../src/core/externalJobs/jobCodec.js";
import type { ServiceResult } from "../src/core/serviceRegistry/types.js";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { json } from "./dispatchHarness.js";
import { echoCompleted, jobPayer, startJobHarness, type JobHarness } from "./externalJobHarness.js";
import { jobKeys } from "./externalJobFixture.js";
import { quoteOrder } from "./gatewayOrderFixture.js";
import { classifyLifecycleRefusal } from "./gatewayLifecycleWire.js";
import { acceptDispatchSnapshotAsGateway } from "./gatewayWire.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";

/** The product's report mapped by a broken mapper: outside the admitted schema. */
const brokenMapping = {
  status: "completed",
  message: "Echo completed.",
  artifacts: [{ name: "echo_result", mimeType: "application/json", data: { message: "hello", extra: true } }],
} as unknown as ServiceResult;

// L03/L-T16: invalid terminal data is neither signed as completed nor used
// to restart the job; it blocks new quotes for that mapping; a repaired
// mapper recovers the same report; failure messages never escape.
describePostgres("external-job terminal results against PostgreSQL", () => {
  let database: DisposableDatabase;
  let h: JobHarness | null = null;

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_job_results", undefined, target.name);
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

  const candidateOf = (taskId: string, row: Record<string, any>) => openJobField(jobKeys(), "candidate", {
    taskId, serviceSlug: "dummy",
  }, { ciphertext: row.result_candidate_ciphertext, keyId: row.result_candidate_key_id });

  it("keeps a job with an invalid report nonterminal, blocks new sales, and completes it once repaired", async () => {
    h = await startJobHarness();
    const harness = h;
    const job = await harness.admit();
    await harness.round();
    let report = brokenMapping;
    harness.adapter.onPoll = async () => ({ kind: "terminal", result: report });
    await harness.due(job.taskId);
    await harness.round();
    const row = await harness.job(job.taskId);
    expect(row).toMatchObject({
      phase: "polling", result_diagnostic: "result_schema_mismatch", last_error_code: "result_invalid",
      failure_count: 1,
    });
    // The rejected candidate is retained, sealed, for repair; never signed.
    expect(candidateOf(job.taskId, row)).toEqual(brokenMapping);
    expect(await harness.claim(job.taskId)).toMatchObject({ state: "external_job", result: null, result_hash: null });
    expect(await harness.status(job)).toMatchObject({ state: "working" });
    expect(classifyLifecycleRefusal("artifact", await harness.lifecycle(job, "artifact"))).toBe("ARTIFACT_NOT_AVAILABLE");
    // The broken mapping stops new quotes; it never restarts the job.
    await expect(quoteOrder({ quotes: harness.rail.quotes, outcome: harness.rail.outcome, payer: jobPayer }))
      .rejects.toThrow(/invalid_result_mapping/);
    // The repaired mapper retrieves the same report and maps it correctly.
    report = echoCompleted;
    await harness.due(job.taskId);
    await harness.round();
    const claim = await harness.claim(job.taskId);
    expect(claim).toMatchObject({ state: "completed", result: echoCompleted });
    expect(`0x${claim.result_hash.toString("hex")}`).toBe(canonicalHash(echoCompleted));
    expect(await harness.job(job.taskId)).toMatchObject({
      phase: "completed", result_candidate_ciphertext: null, result_diagnostic: null,
    });
    expect(harness.adapter.calls.map((entry) => entry.method)).toEqual(["start", "poll", "poll"]);
    await expect(quoteOrder({ quotes: harness.rail.quotes, outcome: harness.rail.outcome, payer: jobPayer }))
      .resolves.toBeDefined();
  });

  it("recovers an immediate terminal start without a handle through its original key", async () => {
    h = await startJobHarness();
    const harness = h;
    harness.adapter.onStart = async () => ({ kind: "terminal", result: brokenMapping });
    const job = await harness.admit();
    await harness.round();
    expect(await harness.job(job.taskId)).toMatchObject({
      phase: "reconciling", result_diagnostic: "result_schema_mismatch", job_reference_ciphertext: null,
    });
    harness.adapter.onRecover = async () => ({ kind: "terminal", result: echoCompleted });
    await harness.due(job.taskId);
    await harness.round();
    expect(await harness.claim(job.taskId)).toMatchObject({ state: "completed", result: echoCompleted });
    const recovered = harness.adapter.calls.find((entry) => entry.method === "recoverStart")!;
    expect(recovered.context.idempotencyKey).toBe(harness.adapter.calls[0]!.context.idempotencyKey);
    expect(harness.adapter.calls.filter((entry) => entry.method === "start")).toHaveLength(1);
  });

  it("attests a product failure only as a reviewed code, never its message", async () => {
    h = await startJobHarness();
    const harness = h;
    const secret = "token=bearer-secret-value";
    const jobs = [];
    for (const errorCode of ["audit_rejected", "not_a_reviewed_code"]) {
      harness.adapter.onStart = async () => ({
        kind: "terminal", result: { status: "failed", errorCode, message: `rejected: ${secret}` },
      });
      jobs.push(await harness.admit());
      await harness.round();
    }
    const expected = [
      { status: "failed", errorCode: "audit_rejected" },
      { status: "failed", errorCode: "service_execution_failed" },
    ];
    for (const [index, job] of jobs.entries()) {
      const claim = await harness.claim(job.taskId);
      expect(claim.result).toEqual(expected[index]);
      expect(JSON.stringify(claim)).not.toContain("bearer-secret-value");
      const status = await acceptDispatchSnapshotAsGateway({ value: await harness.status(job), dispatchHash: job.dispatchHash });
      expect(status.attestation?.resultHash).toBe(canonicalHash(expected[index]));
      expect(JSON.stringify(json(await harness.lifecycle(job, "status")))).not.toContain("bearer-secret-value");
      expect(await harness.job(job.taskId)).toMatchObject({ phase: "failed", input_ciphertext: null });
    }
  });

  it("keeps the diagnostic but no candidate when the rejected result is too large to retain", async () => {
    h = await startJobHarness();
    const harness = h;
    const job = await harness.admit();
    await harness.round();
    harness.adapter.onPoll = async () => ({
      kind: "terminal", result: { ...echoCompleted, message: "x".repeat(1_100_000) },
    });
    await harness.due(job.taskId);
    await harness.round();
    expect(await harness.job(job.taskId)).toMatchObject({
      phase: "polling", result_diagnostic: "result_out_of_bounds", result_candidate_ciphertext: null,
    });
  });
});

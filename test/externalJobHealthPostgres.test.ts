import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_job_health_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import { externalJobHealthCodes, inspectExternalJobs } from "../src/core/externalJobs/health.js";
import { externalJobServicing } from "../src/core/externalJobs/servicing.js";
import { ExternalJobWorker } from "../src/core/externalJobs/worker.js";
import { healthRouter, setServicingHealthSource } from "../src/core/health.js";
import { getAllServices } from "../src/core/serviceRegistry/registry.js";
import { ResultContracts } from "../src/core/standardRail/resultContracts.js";
import { echoCompleted, startJobHarness, TEST_WORKER_SETTINGS, type JobHarness } from "./externalJobHarness.js";
import { jobKeys } from "./externalJobFixture.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";

// L06/L08 health: a stopped worker, stale leases, overdue work, start
// ambiguity, invalid results, repeated failures and unfinished jobs this
// build cannot resume or open raise stable servicing codes, read with
// SELECT only; a healthy worker waiting on a long job raises none; and none
// of them changes routing readiness.
describePostgres("external-job servicing health against PostgreSQL", () => {
  let database: DisposableDatabase;
  let h: JobHarness | null = null;

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_job_health", undefined, target.name);
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

  const inspect = (keys = jobKeys(), audience = h!.rail.config.gatewayAudience) => inspectExternalJobs(
    pool, externalJobServicing(getAllServices(), keys), TEST_WORKER_SETTINGS.leaseSeconds, audience,
  );

  it("reports no code for a healthy worker waiting on a long job, then each servicing problem", async () => {
    h = await startJobHarness({ outcome: { fulfillmentSeconds: 2 } });
    const harness = h;
    harness.adapter.onStart = async () => ({ kind: "accepted", job: { jobId: "long" }, pollAfterSeconds: 28_800 });
    const waiting = await harness.admit();
    await harness.round();
    expect(await harness.waitSeconds(waiting.taskId)).toBe(28_800);
    expect(externalJobHealthCodes(await inspect(), true)).toEqual([]);

    harness.adapter.onStart = async () => ({ kind: "ambiguous", issue: { code: "timeout" } });
    const ambiguous = await harness.admit();
    await harness.round();
    harness.adapter.onStart = async () => ({ kind: "terminal", result: { ...echoCompleted, message: 7 } } as never);
    const invalid = await harness.admit();
    await harness.round();
    await pool.query(
      "UPDATE provider_external_jobs SET failure_count=10, revision=revision + 1 WHERE task_id=$1", [ambiguous.taskId],
    );
    const codes = externalJobHealthCodes(await inspect(), true);
    expect(codes).toEqual(["external_job_start_ambiguous", "external_job_result_invalid", "external_job_failing"]);
    expect((await harness.job(invalid.taskId)).phase).toBe("reconciling");

    // Past the two-second window, every unfinished job is overdue.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(externalJobHealthCodes(await inspect(), true)).toContain("external_job_overdue");
    // A build missing the jobs' key or adapter version reports it.
    expect(externalJobHealthCodes(await inspect(jobKeys("c3", "k3")), true)).toContain("external_job_key_missing");
    await pool.query(
      `UPDATE provider_external_jobs SET lease_owner=gen_random_uuid(), lease_token=gen_random_uuid(),
          lease_expires_at=now() - interval '10 seconds', revision=revision + 1 WHERE task_id=$1`,
      [waiting.taskId],
    );
    const inspection = await inspect();
    expect(inspection).toMatchObject({ active: 3, staleLeases: 1, startAmbiguous: 2, resultInvalid: 1, failing: 1 });
    expect(externalJobHealthCodes(inspection, false)).toEqual([
      "external_job_worker_stopped", "external_job_lease_stale", "external_job_overdue",
      "external_job_start_ambiguous", "external_job_result_invalid", "external_job_failing",
    ]);
  });

  it("records its own heartbeat, reports a stopped worker, and never changes the readiness status", async () => {
    h = await startJobHarness();
    const harness = h;
    const owner = randomUUID();
    await pool.query(
      `INSERT INTO provider_runtime_instances (instance_id,runtime_epoch,revision,capabilities)
       VALUES ($1,1,'test','{"syncExecutionLeases":true,"externalJobWorker":true}')`,
      [owner],
    );
    const worker = new ExternalJobWorker({
      owner, gatewayAudience: harness.rail.config.gatewayAudience, settings: TEST_WORKER_SETTINGS, keys: jobKeys(),
      resultContracts: new ResultContracts(harness.rail.config),
    });
    worker.start();
    await vi.waitFor(async () => {
      const row = (await pool.query("SELECT worker_heartbeat_at FROM provider_runtime_instances WHERE instance_id=$1", [owner])).rows[0];
      expect(row.worker_heartbeat_at).not.toBeNull();
    });
    // (The earlier case's jobs are still unfinished in this database.)
    expect(worker.running()).toBe(true);
    expect(worker.health().codes).not.toContain("external_job_worker_stopped");
    await worker.stop();
    expect(worker.running()).toBe(false);
    expect(worker.health()).toMatchObject({ status: "degraded", codes: expect.arrayContaining(["external_job_worker_stopped"]) });

    const app = express().use("/health", healthRouter).listen(0, "127.0.0.1");
    await once(app, "listening");
    try {
      setServicingHealthSource(() => worker.health());
      const response = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/health/ready`);
      const body = await response.json() as Record<string, unknown>;
      expect(body.servicing).toEqual(worker.health());
      // Routing readiness is decided by the provider's dependencies alone.
      expect(body.status === "ready").toBe(response.status === 200);
    } finally {
      setServicingHealthSource(() => ({ status: "ok", codes: [] }));
      await new Promise<void>((resolve) => app.close(() => resolve()));
    }
  });
});

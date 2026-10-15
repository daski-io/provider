import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_job_upgrade_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import { inspectExternalJobs } from "../src/core/externalJobs/health.js";
import { externalJobSalesStop } from "../src/core/externalJobs/sales.js";
import { externalJobServicing, verifyLiveExternalJobSales } from "../src/core/externalJobs/servicing.js";
import { ExternalJobWorker } from "../src/core/externalJobs/worker.js";
import { parseFieldEncryptionKeys } from "../src/core/security/fieldEncryption.js";
import { clearServicesForTests, registerService } from "../src/core/serviceRegistry/registry.js";
import { ResultContracts } from "../src/core/standardRail/resultContracts.js";
import {
  assertObligationsServiceable,
  loadListingObligations,
  type ExternalJobServicing,
} from "../src/core/standardRail/retainedObligations.js";
import { echoCompleted, startJobHarness, TEST_WORKER_SETTINGS, type JobHarness } from "./externalJobHarness.js";
import { jobKeys, jobRuntime, jobService, scriptedAdapter, setAsyncAdmission } from "./externalJobFixture.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";
import { echoResultSchema } from "./standardRailOutcomeFixture.js";

const rotated = () => parseFieldEncryptionKeys({
  activeKey: `0x${"b2".repeat(32)}`, activeKeyId: "k2", previousKeys: `k1=0x${"a1".repeat(32)}`,
});

// L07/L-T10 against PostgreSQL: an upgrade keeps resuming each job with the
// adapter version, admitted result contract and keys it was admitted under,
// and a build missing any of them cannot take the jobs over.
describePostgres("external jobs across upgrades against PostgreSQL", () => {
  let database: DisposableDatabase;
  let h: JobHarness | null = null;

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_job_upgrade", undefined, target.name);
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

  const worker = (harness: JobHarness, keys = jobKeys(), contracts = new ResultContracts(harness.rail.config)) =>
    new ExternalJobWorker({
      owner: randomUUID(), gatewayAudience: harness.rail.config.gatewayAudience, settings: TEST_WORKER_SETTINGS,
      keys, resultContracts: contracts, random: () => 0.5,
    });

  it("resumes a job with the adapter version that admitted it while new sales use the next", async () => {
    h = await startJobHarness({ version: "v1" });
    const harness = h;
    const v1 = harness.adapter;
    v1.onStart = async () => ({ kind: "accepted", job: { v1Ticket: "t-1" } });
    const old = await harness.admit();
    await harness.round();
    // The upgraded build sells with v2 and retains v1 for the jobs it admitted.
    const v2 = scriptedAdapter("v2");
    v2.onStart = async () => ({ kind: "accepted", job: { v2Handle: { id: "h-2" } } });
    clearServicesForTests();
    registerService(jobService(v2, { previousExternalJobAdapters: { v1 } }));
    v1.onPoll = async (_context, job) => job.v1Ticket === "t-1"
      ? { kind: "terminal", result: echoCompleted }
      : { kind: "retry", issue: { code: "invalid_response" } };
    await harness.due(old.taskId);
    await harness.round(worker(harness));
    expect(await harness.claim(old.taskId)).toMatchObject({ state: "completed", result: echoCompleted });
    expect(v1.calls.map((entry) => entry.method)).toEqual(["start", "poll"]);
    // A new sale (not the same quote again within the second) records v2.
    const fresh = await harness.admit({ message: "after the upgrade" });
    expect((await harness.job(fresh.taskId)).adapter_version).toBe("v2");
    await harness.round(worker(harness));
    expect(v2.calls.map((entry) => [entry.method, entry.context.taskId])).toEqual([["start", fresh.taskId]]);
    // A build that dropped v1 could not have taken the old job over.
    expect(await harness.round(worker(harness))).toBe(0);
  });

  it("validates a late result against the contract its listing version was sold under", async () => {
    h = await startJobHarness();
    const harness = h;
    const job = await harness.admit();
    await harness.round();
    // A newer head admits only short messages; the old version's orders keep theirs.
    const strict = echoResultSchema();
    (strict.properties as Record<string, Record<string, unknown>>).message!.maxLength = 3;
    const newHead = { ...harness.rail.outcome, listingManifestHash: `0x${"5e".repeat(32)}` as Hex, resultSchema: strict };
    const contracts = new ResultContracts({ servicing: new Map([
      [harness.rail.outcome.listingManifestHash, harness.rail.outcome], [newHead.listingManifestHash, newHead],
    ]) });
    harness.adapter.onPoll = async () => ({ kind: "terminal", result: echoCompleted });
    await harness.due(job.taskId);
    await harness.round(worker(harness, jobKeys(), contracts));
    expect(await harness.claim(job.taskId)).toMatchObject({ state: "completed", result: echoCompleted });
  });

  it("opens a job sealed before a key rotation, and refuses to take it over without that key", async () => {
    h = await startJobHarness({ version: "v1" });
    const harness = h;
    const job = await harness.admit();
    await harness.round();
    const module = jobService(harness.adapter);
    const keys = rotated();
    const servicing = (services = [module], ring = keys) => externalJobServicing(services, ring);
    // The takeover check boot, the importer and activation run, scoped to
    // this suite's listing version.
    const config = harness.rail.config;
    const takeover = async (externalJobs: ExternalJobServicing, catalog = config) => {
      const all = await loadListingObligations(pool, config.gatewayAudience, catalog);
      assertObligationsServiceable({
        catalog,
        obligations: new Map([...all].filter(([hash]) => hash === harness.rail.outcome.listingManifestHash)),
        signingWallets: new Set([config.terminalAttestationKey]),
        externalJobs,
      });
    };
    await expect(takeover(servicing())).resolves.toBeUndefined();
    await expect(takeover(servicing([module],
      parseFieldEncryptionKeys({ activeKey: `0x${"b2".repeat(32)}`, activeKeyId: "k2", previousKeys: "" }))))
      .rejects.toThrow(/\(encryption key k1 not configured\)/);
    await expect(takeover(servicing([jobService(scriptedAdapter("v2"))])))
      .rejects.toThrow(/\(external-job adapter dummy@v1 not installed\)/);
    await expect(takeover(servicing(), { ...config, servicing: new Map() }))
      .rejects.toThrow(/\(definition_unavailable\)/);
    // The rotated build opens the old reference and seals new state with k2.
    harness.adapter.onPoll = async (_context, reference) => (reference.jobId === "job-1"
      ? { kind: "terminal", result: echoCompleted } : { kind: "retry", issue: { code: "invalid_response" } });
    await harness.due(job.taskId);
    await harness.round(worker(harness, keys));
    expect(await harness.claim(job.taskId)).toMatchObject({ state: "completed" });
    // Finished jobs keep no encrypted state, so no key is needed for them.
    await expect(takeover(servicing([module], jobKeys("c3", "k3")))).resolves.toBeUndefined();
    // An unfinished job may still need new state sealed: a build with only
    // read-only keys cannot take it over.
    const pending = await harness.admit();
    await expect(takeover(servicing([module],
      parseFieldEncryptionKeys({ activeKeyId: "primary", previousKeys: `k1=0x${"a1".repeat(32)}` }))))
      .rejects.toThrow(/\(no active encryption key for unfinished external jobs\)/);
    expect((await harness.job(pending.taskId)).phase).toBe("queued");
  });
  it("joins running instances only if it resumes every adapter version they sell", async () => {
    h = await startJobHarness({ version: "v1" });
    const harness = h;
    const current = jobService(harness.adapter);
    const older = randomUUID();
    await pool.query(
      `INSERT INTO provider_runtime_instances (instance_id,runtime_epoch,revision,capabilities)
       VALUES ($1,1,'older',$2::jsonb)`,
      [older, JSON.stringify({
        syncExecutionLeases: true, externalJobWorker: true,
        externalJobAdapters: { dummy: ["v0"] }, externalJobSales: { dummy: "v0" },
      })],
    );
    try {
      // The older instance may still admit v0 jobs: a build that cannot resume them is refused at boot.
      await expect(verifyLiveExternalJobSales(pool, [current]))
        .rejects.toThrow("running instances sell external-job adapter versions this build cannot resume: dummy@v0");
      await expect(verifyLiveExternalJobSales(pool, [
        jobService(harness.adapter, { previousExternalJobAdapters: { v0: scriptedAdapter("v0") } }),
      ])).resolves.toBeUndefined();
      // While async admission is off nobody admits external jobs.
      await setAsyncAdmission(pool, false);
      await expect(verifyLiveExternalJobSales(pool, [current])).resolves.toBeUndefined();
    } finally {
      await setAsyncAdmission(pool, true);
      await pool.query("UPDATE provider_runtime_instances SET stopped_at=now() WHERE instance_id=$1", [older]);
    }
  });

  it("claims nothing without an active key, and reports the jobs it cannot service", async () => {
    h = await startJobHarness({ version: "v1" });
    const harness = h;
    const job = await harness.admit();
    // Read-only keys open stored state but cannot seal the reference a start returns.
    const readOnly = parseFieldEncryptionKeys({ activeKeyId: "primary", previousKeys: `k1=0x${"a1".repeat(32)}` });
    expect(await harness.round(worker(harness, readOnly))).toBe(0);
    expect(harness.adapter.calls).toEqual([]);
    const inspection = await inspectExternalJobs(
      pool, externalJobServicing([jobService(harness.adapter)], readOnly), TEST_WORKER_SETTINGS.leaseSeconds,
      harness.rail.config.gatewayAudience,
    );
    expect(inspection.keyMissing).toBe(inspection.active);
    expect(inspection.active).toBeGreaterThan(0);
    // A process with an active key takes the job over.
    await harness.round();
    expect((await harness.job(job.taskId)).phase).toBe("polling");
  });

  it("services, reports and stops sales only for its own gateway audience", async () => {
    h = await startJobHarness({ version: "v1" });
    const harness = h;
    const job = await harness.admit();
    const other = "https://other-gateway.example";
    const elsewhere = new ExternalJobWorker({
      owner: randomUUID(), gatewayAudience: other, settings: TEST_WORKER_SETTINGS, keys: jobKeys(),
      resultContracts: new ResultContracts(harness.rail.config), random: () => 0.5,
    });
    expect(await harness.round(elsewhere)).toBe(0);
    const servicing = externalJobServicing([jobService(harness.adapter)], jobKeys());
    await expect(inspectExternalJobs(pool, servicing, TEST_WORKER_SETTINGS.leaseSeconds, other))
      .resolves.toMatchObject({ active: 0 });
    // A rejected result of this audience stops its sales; another audience's never does.
    await pool.query(
      "UPDATE provider_external_jobs SET result_diagnostic='result_schema_mismatch', revision=revision + 1 WHERE task_id=$1",
      [job.taskId],
    );
    const sale = { serviceSlug: "dummy", skillId: harness.rail.outcome.skillId, adapter: harness.adapter };
    const runtime = jobRuntime(jobKeys());
    await expect(externalJobSalesStop(runtime, pool, { ...sale, gatewayAudience: harness.rail.config.gatewayAudience }))
      .resolves.toBe("invalid_result_mapping");
    await expect(externalJobSalesStop(runtime, pool, { ...sale, gatewayAudience: other })).resolves.toBeNull();
    await harness.round();
    expect((await harness.job(job.taskId)).phase).toBe("polling");
  });
});

import { spawnSync } from "node:child_process";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { withRuntimeEpochMarker } from "../src/core/db/runtimeEpoch.js";
import {
  createDisposableDatabase,
  createDisposableRole,
  databaseUrl,
  describePostgres,
  type DisposableDatabase,
  type DisposableRole,
} from "./postgresHarness.js";
import { jobKeys } from "./externalJobFixture.js";
import { providerProcessEnv } from "./providerProcessEnv.js";
import { railConfig } from "./standardRailServiceFixture.js";

// L-T14 (activation part) and L07: async admission stays off through
// migrations, the importer and boot, and only the explicit activation
// command turns it on, after every prerequisite holds in one transaction.
describePostgres("database-backed async-admission switch", () => {
  let migrator: DisposableRole;
  let runtime: DisposableRole;
  let database: DisposableDatabase;
  let owner: pg.Client;
  let modules: {
    pool: typeof import("../src/core/db/pool.js");
    startup: typeof import("../src/core/db/startup.js");
    admission: typeof import("../src/core/standardRail/asyncAdmission.js");
    activation: typeof import("../src/core/standardRail/asyncAdmissionActivation.js");
    instances: typeof import("../src/core/runtimeInstance.js");
  };
  const config = railConfig();

  const worker = (id: string, capabilities: Record<string, unknown>, epoch = 1) => owner.query(
    `INSERT INTO provider_runtime_instances (instance_id,runtime_epoch,revision,capabilities)
     VALUES ($1,$2,'test',$3::jsonb)`,
    [id, epoch, JSON.stringify(capabilities)],
  );
  const activate = (keys = jobKeys()) => modules.activation.activateAsyncAdmission(
    () => modules.pool.migrationPool.connect(), config, keys,
  );
  const failed = (checks: Array<{ name: string; ok: boolean }>) =>
    checks.filter((check) => !check.ok).map((check) => check.name);

  beforeAll(async () => {
    migrator = await createDisposableRole("lite_async_migrator");
    runtime = await createDisposableRole("lite_async_runtime");
    database = await createDisposableDatabase("lite_async", migrator.name);
    process.env.DATABASE_URL = databaseUrl(database.name, runtime);
    process.env.MIGRATION_DATABASE_URL = databaseUrl(database.name, migrator);
    modules = {
      pool: await import("../src/core/db/pool.js"),
      startup: await import("../src/core/db/startup.js"),
      admission: await import("../src/core/standardRail/asyncAdmission.js"),
      activation: await import("../src/core/standardRail/asyncAdmissionActivation.js"),
      instances: await import("../src/core/runtimeInstance.js"),
    };
    await modules.startup.prepareProviderDatabase();
    owner = new pg.Client(withRuntimeEpochMarker(databaseUrl(database.name, migrator)));
    await owner.connect();
  }, 60_000);

  beforeEach(async () => {
    await owner.query("UPDATE provider_runtime_instances SET stopped_at=now() WHERE stopped_at IS NULL");
  });

  afterAll(async () => {
    await owner?.end().catch(() => undefined);
    await modules?.pool.closeMigrationPool().catch(() => undefined);
    await modules?.pool.pool.end().catch(() => undefined);
    await database?.drop();
    await runtime?.drop();
    await migrator?.drop();
  });

  it("is off after migrating and cannot be turned on by the runtime role", async () => {
    await expect(modules.admission.readAsyncAdmission(modules.pool.pool))
      .resolves.toEqual({ enabled: false, changedAt: null });
    await expect(modules.pool.pool.query("UPDATE provider_async_admission SET enabled=true"))
      .rejects.toThrow(/permission denied/);
  });

  it("refuses while an instance without the external-job worker runs, or none runs", async () => {
    // A process from before the worker existed still declares none.
    await worker("00000000-0000-4000-8000-0000000000c1", { syncExecutionLeases: true, externalJobWorker: false });
    const result = await activate();
    expect(result.enabled).toBe(false);
    expect(failed(result.checks)).toEqual(["compatible_workers"]);
    expect(result.checks.find((check) => check.name === "compatible_workers")?.detail)
      .toBe("1 running instances are not compatible external-job workers");
    await owner.query("UPDATE provider_runtime_instances SET stopped_at=now() WHERE stopped_at IS NULL");
    expect(failed((await activate()).checks)).toEqual(["compatible_workers"]);
    await expect(modules.admission.readAsyncAdmission(modules.pool.pool)).resolves.toMatchObject({ enabled: false });
    // This build's own instance runs the worker.
    expect(modules.instances.BUILD_CAPABILITIES.externalJobWorker).toBe(true);
  });

  it("refuses while a running instance cannot resume an adapter version new sales need", async () => {
    const registry = await import("../src/core/serviceRegistry/registry.js");
    const fixture = await import("./externalJobFixture.js");
    registry.clearServicesForTests();
    registry.registerService(fixture.jobService(fixture.scriptedAdapter("v7")));
    try {
      await worker("00000000-0000-4000-8000-0000000000e1", {
        syncExecutionLeases: true, externalJobWorker: true, externalJobAdapters: { dummy: ["v6"] },
      });
      const refused = await activate();
      expect(failed(refused.checks)).toEqual(["external_job_services"]);
      expect(refused.checks.find((check) => check.name === "external_job_services")?.detail)
        .toBe("1 running instances cannot resume every required external-job adapter version");
      await owner.query("UPDATE provider_runtime_instances SET stopped_at=now() WHERE stopped_at IS NULL");
      await worker("00000000-0000-4000-8000-0000000000e2", {
        syncExecutionLeases: true, externalJobWorker: true, externalJobAdapters: { dummy: ["v6", "v7"] },
      });
      const accepted = await activate();
      expect(accepted.checks.find((check) => check.name === "external_job_services"))
        .toMatchObject({ ok: true, detail: "1 adapter versions on every instance" });
      await modules.activation.deactivateAsyncAdmission(modules.pool.migrationPool);
      // Another running instance sells v8, which the first cannot resume.
      await worker("00000000-0000-4000-8000-0000000000e3", {
        syncExecutionLeases: true, externalJobWorker: true,
        externalJobAdapters: { dummy: ["v7", "v8"] }, externalJobSales: { dummy: "v8" },
      });
      const mixed = await activate();
      expect(failed(mixed.checks)).toEqual(["external_job_services"]);
      expect(mixed.enabled).toBe(false);
    } finally {
      registry.clearServicesForTests();
    }
  });

  it("refuses without an active encryption key to seal new jobs", async () => {
    await worker("00000000-0000-4000-8000-0000000000d1", { syncExecutionLeases: true, externalJobWorker: true });
    const result = await activate({ activeKeyId: null, keys: new Map() });
    expect(result.enabled).toBe(false);
    expect(failed(result.checks)).toEqual(["encryption_keys"]);
  });

  it("refuses while a pre-R1 execution awaits the cutover or the barrier is weakened", async () => {
    await worker("00000000-0000-4000-8000-0000000000a1", { syncExecutionLeases: true, externalJobWorker: true });
    await owner.query("ALTER TABLE provider_transactions DROP CONSTRAINT provider_transactions_execution_lease");
    try {
      await owner.query(`INSERT INTO provider_transactions (
          id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
          service_slug,skill_id,listing_manifest_hash,state,dispatch_valid_before)
        VALUES ('task-pre-r1','https://gateway.example','ord_pre_r1',decode(repeat('01',32),'hex'),
          decode(repeat('02',32),'hex'),decode(repeat('03',32),'hex'),
          '0x1111111111111111111111111111111111111111','dummy','echo',
          decode(repeat('11',32),'hex'),'executing',now() + interval '5 minutes')`);
      expect(failed((await activate()).checks)).toEqual(["legacy_executions"]);
      await owner.query(`UPDATE provider_transactions SET state='failed',
          result='{"status":"failed","errorCode":"provider_restarted_during_execution"}',
          result_hash=decode('d6e4e6fbc0fa4b5d4f7f45cde3a3d8fc6c7b1acb0b6f1ac6e1fc7f4b0c43fa0b','hex'),
          completed_at=now() WHERE id='task-pre-r1'`);
    } finally {
      await owner.query(`ALTER TABLE provider_transactions ADD CONSTRAINT provider_transactions_execution_lease
        CHECK (state <> 'executing' OR (execution_owner IS NOT NULL AND execution_lease_token IS NOT NULL
          AND execution_lease_expires_at IS NOT NULL)) NOT VALID`);
    }
    await owner.query("ALTER TABLE rate_limit_buckets DISABLE TRIGGER rate_limit_buckets_runtime_epoch");
    try {
      expect(failed((await activate()).checks)).toEqual(["compatibility_barrier"]);
    } finally {
      await owner.query("ALTER TABLE rate_limit_buckets ENABLE TRIGGER rate_limit_buckets_runtime_epoch");
    }
  });

  it("refuses an incompatible running instance, then activates and deactivates with evidence", async () => {
    await worker("00000000-0000-4000-8000-0000000000b1", { syncExecutionLeases: true, externalJobWorker: true });
    await worker("00000000-0000-4000-8000-0000000000b2", { syncExecutionLeases: true, externalJobWorker: true }, 2);
    expect(failed((await activate()).checks)).toEqual(["compatible_workers"]);
    await owner.query("UPDATE provider_runtime_instances SET stopped_at=now() WHERE runtime_epoch=2");
    const result = await activate();
    expect(result).toMatchObject({ enabled: true });
    const row = (await owner.query("SELECT enabled, changed_at, evidence FROM provider_async_admission")).rows[0];
    expect(row.enabled).toBe(true);
    expect(row.evidence.checks.map((check: { name: string; ok: boolean }) => [check.name, check.ok])).toEqual([
      ["compatibility_barrier", true], ["legacy_executions", true],
      ["retained_obligations", true], ["compatible_workers", true], ["encryption_keys", true],
      ["external_job_services", true],
    ]);
    await modules.activation.deactivateAsyncAdmission(modules.pool.migrationPool);
    await expect(modules.admission.readAsyncAdmission(modules.pool.pool)).resolves.toMatchObject({ enabled: false });
  });

  it("runs as the operator command: reports read-only, and --activate fails closed without a worker", async () => {
    const env = await providerProcessEnv({
      databaseUrl: databaseUrl(database.name, runtime),
      migrationDatabaseUrl: databaseUrl(database.name, migrator),
    });
    const command = (...args: string[]) => spawnSync(
      process.execPath, ["--import=tsx", "src/activateAsyncAdmission.ts", ...args],
      { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000 },
    );
    const report = (stdout: string) => JSON.parse(stdout.trim().split("\n").at(-1)!);
    const status = command();
    expect(status.status, status.stderr).toBe(0);
    expect(report(status.stdout)).toMatchObject({ asyncAdmission: { enabled: false } });
    // Its own catalog is empty, so the earlier claim's version is not
    // installed either, and it runs with no encryption key; every refusal
    // is reported.
    expect(failed(report(status.stdout).checks))
      .toEqual(["retained_obligations", "compatible_workers", "encryption_keys"]);
    const refused = command("--activate");
    expect(refused.status).toBe(1);
    expect(report(refused.stdout).asyncAdmission.enabled).toBe(false);
  }, 120_000);
});

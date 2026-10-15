import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { withRuntimeEpochMarker } from "../src/core/db/runtimeEpoch.js";
import { withReadOnlySnapshot } from "../src/core/diagnostics/readOnlySession.js";
import { providerKey } from "./gatewayWire.js";
import {
  createDisposableDatabase,
  createDisposableRole,
  databaseUrl,
  describePostgres,
  type DisposableDatabase,
  type DisposableRole,
} from "./postgresHarness.js";
import { providerProcessEnv } from "./providerProcessEnv.js";

const baseline = readFileSync(new URL("../src/core/db/migrations/001_initial.sql", import.meta.url), "utf8");
const ENCRYPTION_KEY = `0x${"5d".repeat(32)}`;
const INPUT_MARKER = "doctor-input-marker-never-printed";
const GATEWAY = "https://gateway.example";

interface Report {
  schemaVersion: number;
  database: string;
  ok: boolean;
  checks: Array<{ code: string; status: string; message: string; details?: Record<string, any> }>;
}

/** A database a pre-R1 image used: the baseline schema and one interrupted call. */
async function preR1Database(owner: DisposableRole, prefix: string): Promise<DisposableDatabase> {
  const database = await createDisposableDatabase(prefix, owner.name);
  const client = new pg.Client({ connectionString: databaseUrl(database.name, owner) });
  await client.connect();
  try {
    await client.query(`CREATE TABLE _migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await client.query(baseline);
    await client.query("INSERT INTO _migrations (name, checksum) VALUES ($1, $2)", [
      "001_initial.sql", createHash("sha256").update(baseline).digest("hex"),
    ]);
    await client.query(`INSERT INTO provider_transactions (
        id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
        service_slug,skill_id,listing_manifest_hash,state,created_at)
      VALUES ('task-pre-r1',$1,'ord_pre_r1',decode(repeat('01',32),'hex'),
        decode(repeat('02',32),'hex'),decode(repeat('03',32),'hex'),
        '0x1111111111111111111111111111111111111111','dummy','echo',
        decode(repeat('04',32),'hex'),'executing',now() - interval '10 minutes')`, [GATEWAY]);
  } finally {
    await client.end();
  }
  return database;
}

// L08/L-T20: the doctor's database mode reads one snapshot (SELECT only, in
// a READ ONLY transaction), reports schema epoch, admission state, running
// workers, pre-R1 executions, unfinished external jobs (stale, overdue,
// missing handler or key) and retained obligations as counts and opaque
// references, tells checks it did not perform apart from passing ones, and
// prints no secret, input or key.
describePostgres("doctor database mode against PostgreSQL", () => {
  let migrator: DisposableRole;
  let runtime: DisposableRole;
  let database: DisposableDatabase;
  let legacyOnly: DisposableDatabase;
  let env: NodeJS.ProcessEnv;

  const owner = () => {
    const client = new pg.Client(withRuntimeEpochMarker(databaseUrl(database.name, migrator)));
    return client.connect().then(() => client);
  };
  const doctor = (overrides: NodeJS.ProcessEnv = {}, ...args: string[]) => {
    const result = spawnSync(process.execPath, ["scripts/doctor.mjs", "--stage=testnet", "--json", ...args], {
      cwd: process.cwd(), env: { ...env, ...overrides }, encoding: "utf8", timeout: 90_000,
    });
    return { result, report: JSON.parse(result.stdout) as Report };
  };
  const byCode = (report: Report) => Object.fromEntries(report.checks.map((item) => [item.code, item]));
  // Every table's full content, so a run that changed anything is caught.
  const contents = async () => {
    const client = await owner();
    try {
      const tables = (await client.query<{ name: string }>(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY 1",
      )).rows.map((row) => row.name);
      const digests: Record<string, string> = {};
      for (const table of tables) {
        digests[table] = (await client.query<{ digest: string }>(
          `SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) AS digest FROM "${table}" t`,
        )).rows[0]!.digest;
      }
      return digests;
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    migrator = await createDisposableRole("lite_doctor_migrator");
    runtime = await createDisposableRole("lite_doctor_runtime");
    database = await preR1Database(migrator, "lite_doctor");
    legacyOnly = await preR1Database(migrator, "lite_doctor_pre_r1");
    env = {
      ...await providerProcessEnv({
        databaseUrl: databaseUrl(database.name, runtime),
        migrationDatabaseUrl: databaseUrl(database.name, migrator),
      }),
      PROVIDER_DATA_ENCRYPTION_KEY: ENCRYPTION_KEY,
    };
    // The operator's cutover inventory migrates this database to R1 and
    // grants the runtime role; the interrupted pre-R1 call stays open.
    const cutover = spawnSync(process.execPath, ["--import=tsx", "src/upgradeCutover.ts"], {
      cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000,
    });
    expect(cutover.status, cutover.stderr).toBe(0);
    const client = await owner();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO provider_transactions (
          id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,service_slug,skill_id,
          listing_manifest_hash,state,dispatch_valid_before)
        VALUES ('task-job-1',$1,'ord_job_1',decode(repeat('11',32),'hex'),decode(repeat('12',32),'hex'),
          decode(repeat('13',32),'hex'),'0x2222222222222222222222222222222222222222','dummy','echo',
          decode(repeat('14',32),'hex'),'external_job',now() + interval '5 minutes')`, [GATEWAY]);
      // Admitted two hours ago, overdue an hour, under an adapter version and
      // a key this build does not have.
      await client.query(`INSERT INTO provider_external_jobs (
          task_id,adapter_version,idempotency_key,input_ciphertext,input_key_id,accepted_at,fulfillment_deadline)
        VALUES ('task-job-1','audit-v0','00000000-0000-8000-8000-0000000000d1',$1,'retired-key',
          now() - interval '2 hours', now() - interval '1 hour')`, [`daski:v1:${INPUT_MARKER}`]);
      await client.query("COMMIT");
      await client.query(`INSERT INTO supplier_operations (service_id,op_key,kind,state)
        VALUES ('dummy','op-ambiguous','example.mutation','ambiguous')`);
      // A process that heartbeats while its worker went silent.
      await client.query(`INSERT INTO provider_runtime_instances
          (instance_id,runtime_epoch,revision,capabilities,started_at,heartbeat_at,worker_heartbeat_at)
        VALUES ('00000000-0000-4000-8000-0000000000aa',1,'r-test',
          '{"syncExecutionLeases":true,"externalJobWorker":true}',
          now() - interval '10 minutes', now(), now() - interval '5 minutes')`);
    } finally {
      await client.end();
    }
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
    await legacyOnly?.drop();
    await runtime?.drop();
    await migrator?.drop();
  });

  it("reports every owed condition as the runtime role, changes nothing and prints no secret", async () => {
    const before = await contents();
    const { result, report } = await Promise.resolve(doctor({}, "--database"));
    expect(await contents()).toEqual(before);
    expect(result.status).toBe(1);
    expect(report).toMatchObject({ schemaVersion: 2, database: "performed", ok: false });
    const checks = byCode(report);
    expect(checks.DATABASE_DIAGNOSTICS?.status).toBe("pass");
    expect(checks.DATABASE_SCHEMA_EPOCH).toMatchObject({ status: "pass", details: { databaseEpoch: 1, buildEpoch: 1 } });
    // The runtime principal cannot read the ledger: not performed, not passed.
    expect(checks.DATABASE_MIGRATIONS?.status).toBe("skip");
    expect(checks.ASYNC_ADMISSION).toMatchObject({ status: "pass", details: { enabled: false } });
    expect(checks.RUNTIME_INSTANCES).toMatchObject({
      status: "warn",
      details: { running: 1, liveWorkers: 0, stoppedWorkers: ["00000000-0000-4000-8000-0000000000aa"] },
    });
    expect(checks.LEGACY_EXECUTIONS).toMatchObject({ status: "fail", details: { count: 1, taskIds: ["task-pre-r1"] } });
    expect(checks.SUPPLIER_OPERATIONS).toMatchObject({ status: "warn", details: { intent: 0, ambiguous: 1 } });
    expect(checks.EXTERNAL_JOBS).toMatchObject({
      status: "fail",
      details: {
        active: 1, overdue: 1, handlerMissing: 1, keyMissing: 1,
        codes: ["external_job_worker_stopped", "external_job_overdue", "external_job_handler_missing",
          "external_job_key_missing"],
      },
    });
    expect(checks.RUNTIME_CATALOG).toMatchObject({ status: "warn", details: { heads: 0, unlistedPaidSkills: ["dummy:echo"] } });
    expect(checks.RETAINED_OBLIGATIONS?.status).toBe("fail");
    expect(checks.RETAINED_OBLIGATIONS?.message).toContain("listing version not installed");
    for (const secret of [providerKey, ENCRYPTION_KEY.slice(2), runtime.password, migrator.password,
      INPUT_MARKER, String(env.RATE_LIMIT_HASH_KEY)]) {
      expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    }
  });

  it("compares the migration ledger as the schema owner", () => {
    const { report } = doctor({ DATABASE_URL: databaseUrl(database.name, migrator) }, "--database");
    expect(byCode(report).DATABASE_MIGRATIONS).toMatchObject({
      status: "pass", details: { pending: [], unknown: [], changed: [] },
    });
  });

  it("reports a pre-R1 schema and leaves every check that needs this build's schema unperformed", () => {
    const { report } = doctor({ DATABASE_URL: databaseUrl(legacyOnly.name, migrator) }, "--database");
    const checks = byCode(report);
    expect(report.database).toBe("performed");
    expect(checks.DATABASE_SCHEMA_EPOCH).toMatchObject({ status: "fail", details: { databaseEpoch: 0 } });
    expect(checks.DATABASE_MIGRATIONS).toMatchObject({ status: "warn", details: { applied: 1 } });
    for (const code of ["ASYNC_ADMISSION", "RUNTIME_INSTANCES", "LEGACY_EXECUTIONS", "EXTERNAL_JOBS",
      "RUNTIME_CATALOG", "RETAINED_OBLIGATIONS"]) {
      expect(checks[code]?.status, code).toBe("skip");
    }
  });

  it("stays offline, reporting database checks as not performed, without --database", () => {
    const { report } = doctor();
    expect(report.database).toBe("not_performed");
    expect(byCode(report).DATABASE_DIAGNOSTICS?.status).toBe("skip");
    expect(report.checks.map((item) => item.code)).not.toContain("DATABASE_SCHEMA_EPOCH");
  });

  it("runs in a snapshot PostgreSQL itself keeps read-only", async () => {
    const session = {
      connectionString: databaseUrl(database.name, migrator),
      statementTimeoutMs: 5_000,
      connectTimeoutMs: 5_000,
    };
    await expect(withReadOnlySnapshot(session, (db) => db.query(
      "UPDATE provider_async_admission SET enabled=true, changed_at=now(), evidence='{}'::jsonb WHERE singleton",
    ))).rejects.toMatchObject({ code: "25006" });
    await expect(withReadOnlySnapshot(session, async (db) => {
      await db.query("SELECT 1");
      return db.query("SET TRANSACTION READ WRITE");
    })).rejects.toMatchObject({ code: "25001" });
    const client = await owner();
    try {
      expect((await client.query("SELECT enabled FROM provider_async_admission")).rows).toEqual([{ enabled: false }]);
    } finally {
      await client.end();
    }
  });
});

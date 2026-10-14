import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { withRuntimeEpochMarker } from "../src/core/db/runtimeEpoch.js";
import {
  createDisposableDatabase,
  createDisposableRole,
  databaseUrl,
  describePostgres,
  type DisposableDatabase,
  type DisposableRole,
} from "./postgresHarness.js";

const BARRIER = /provider compatibility barrier/;
const baseline = readFileSync(new URL("../src/core/db/migrations/001_initial.sql", import.meta.url), "utf8");

// The pre-R1 image's own statements, verbatim from 1d3fb23 (pool.ts,
// transactionStore.ts, rateLimit.ts).
const LEGACY_LEDGER_CREATE = `
        CREATE TABLE IF NOT EXISTS _migrations (
          name TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
const LEGACY_LEDGER_READ = "SELECT name, checksum FROM _migrations";
const LEGACY_SWEEP = `UPDATE provider_transactions
        SET state='failed',
            result='{"status":"failed","errorCode":"provider_restarted_during_execution"}'::jsonb,
            completed_at=now()
      WHERE state='executing'`;
const LEGACY_CLAIM = `INSERT INTO provider_transactions (
         id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
         service_slug,skill_id,listing_manifest_hash,state
       ) VALUES ('task-legacy','https://gateway.example','ord_legacy',decode(repeat('11',32),'hex'),
         decode(repeat('22',32),'hex'),decode(repeat('33',32),'hex'),
         '0x1111111111111111111111111111111111111111','dummy','echo',decode(repeat('44',32),'hex'),
         'executing')`;
const LEGACY_RATE_LIMIT = `INSERT INTO rate_limit_buckets (bucket_key,tokens,last_refill,expires_at)
       VALUES ('legacy',1,now(),now() + interval '1 minute')
       ON CONFLICT (bucket_key) DO UPDATE SET tokens=rate_limit_buckets.tokens - 1`;

// L-T14/C-T07 in CI: the database, not the executable, keeps sessions
// without this build's runtime-epoch marker away from provider state.
describePostgres("legacy-process compatibility barrier against PostgreSQL", () => {
  let migrator: DisposableRole;
  let runtime: DisposableRole;
  let database: DisposableDatabase;
  let modules: {
    pool: typeof import("../src/core/db/pool.js");
    startup: typeof import("../src/core/db/startup.js");
    epoch: typeof import("../src/core/db/runtimeEpoch.js");
  };
  const clients: pg.Client[] = [];

  async function connect(role: DisposableRole, marked: boolean, epoch?: number): Promise<pg.Client> {
    const url = databaseUrl(database.name, role);
    const client = new pg.Client(marked
      ? epoch ? { connectionString: url, options: `-c daski.runtime_epoch=${epoch}` } : withRuntimeEpochMarker(url)
      : { connectionString: url });
    await client.connect();
    clients.push(client);
    return client;
  }

  async function snapshot(): Promise<string> {
    const owner = await connect(migrator, true);
    const tables = await owner.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename",
    );
    const parts: string[] = [];
    for (const { tablename } of tables.rows) {
      const rows = await owner.query(`SELECT t::text AS row FROM "${tablename}" t ORDER BY 1`);
      parts.push(`${tablename}:${rows.rows.map((row) => row.row).join("|")}`);
    }
    return parts.join("\n");
  }

  beforeAll(async () => {
    migrator = await createDisposableRole("lite_barrier_migrator");
    runtime = await createDisposableRole("lite_barrier_runtime");
    database = await createDisposableDatabase("lite_barrier", migrator.name);
    process.env.DATABASE_URL = databaseUrl(database.name, runtime);
    process.env.MIGRATION_DATABASE_URL = databaseUrl(database.name, migrator);
    modules = {
      pool: await import("../src/core/db/pool.js"),
      startup: await import("../src/core/db/startup.js"),
      epoch: await import("../src/core/db/runtimeEpoch.js"),
    };
    // A database the pre-R1 image created: its ledger, its baseline, its rows.
    const legacy = await connect(migrator, false);
    await legacy.query(LEGACY_LEDGER_CREATE);
    await legacy.query(baseline);
    await legacy.query("INSERT INTO _migrations (name, checksum) VALUES ($1, $2)", [
      "001_initial.sql", createHash("sha256").update(baseline).digest("hex"),
    ]);
    await legacy.query(LEGACY_CLAIM);
    await legacy.query(`UPDATE provider_transactions SET state='completed',
        result='{"status":"completed","message":"old"}'::jsonb,completed_at=now()
      WHERE id='task-legacy' AND state='executing'`);
    await modules.startup.prepareProviderDatabase();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
    await modules?.pool.closeMigrationPool().catch(() => undefined);
    await modules?.pool.pool.end().catch(() => undefined);
    await database?.drop();
    await runtime?.drop();
    await migrator?.drop();
  });

  it("migrates a pre-R1 database without touching its rows", async () => {
    const owner = await connect(migrator, true);
    const ledger = await owner.query<{ name: string }>("SELECT name FROM _migrations ORDER BY name");
    expect(ledger.rows.map((row) => row.name)).toContain("005_runtime_epoch_barrier.sql");
    const row = await owner.query("SELECT state,result,result_hash FROM provider_transactions");
    expect(row.rows).toEqual([{ state: "completed", result: { status: "completed", message: "old" }, result_hash: null }]);
  });

  it("refuses the pre-R1 boot sequence before its privilege reset, as owner or runtime role", async () => {
    const before = await snapshot();
    const owner = await connect(migrator, false);
    // The runner's ledger creation is a no-op; its first read already fails.
    await owner.query(LEGACY_LEDGER_CREATE);
    await expect(owner.query(LEGACY_LEDGER_READ)).rejects.toThrow(BARRIER);
    for (const client of [owner, await connect(runtime, false)]) {
      // The unconditional startup sweep matches no executing row here.
      await expect(client.query(LEGACY_SWEEP)).rejects.toThrow(BARRIER);
      await expect(client.query(LEGACY_CLAIM)).rejects.toThrow(BARRIER);
      await expect(client.query(LEGACY_RATE_LIMIT)).rejects.toThrow(BARRIER);
      await expect(client.query(
        "UPDATE provider_runtime_listing_versions SET superseded_at=now() WHERE false",
      )).rejects.toThrow(client === owner ? BARRIER : /permission denied/);
    }
    expect(await snapshot()).toBe(before);
  });

  it("admits this build's sessions, including two overlapping processes", async () => {
    const first = await connect(runtime, true);
    const second = await connect(runtime, true);
    await first.query(LEGACY_RATE_LIMIT.replaceAll("'legacy'", "'overlap'"));
    await second.query(LEGACY_RATE_LIMIT.replaceAll("'legacy'", "'overlap'"));
    const bucket = await first.query("SELECT tokens FROM rate_limit_buckets WHERE bucket_key='overlap'");
    expect(bucket.rows[0]?.tokens).toBe(0);
    await expect(modules.epoch.verifyRuntimeEpochMarker(modules.pool.pool)).resolves.toBeUndefined();
  });

  it("checks independently of the caller's search_path, as pg_dump empties it", async () => {
    for (const marked of [true, false]) {
      const client = await connect(migrator, marked);
      const schema = (await client.query<{ schema: string }>("SELECT current_schema() AS schema")).rows[0]!.schema;
      await client.query("SELECT pg_catalog.set_config('search_path', '', false)");
      const write = client.query(`UPDATE "${schema}".rate_limit_buckets SET tokens=tokens WHERE false`);
      if (marked) await expect(write).resolves.toBeDefined();
      else await expect(write).rejects.toThrow(BARRIER);
    }
  });

  it("refuses to start against a newer schema epoch, and the database refuses older markers", async () => {
    const newer = await connect(migrator, true, 2);
    await newer.query("UPDATE provider_schema_epoch SET epoch=2");
    try {
      await expect(modules.startup.prepareProviderDatabase())
        .rejects.toThrow(/schema epoch 2 is newer than this build supports/);
      const current = await connect(runtime, true);
      await expect(current.query(LEGACY_RATE_LIMIT)).rejects.toThrow(/runtime epoch 1 is older than schema epoch 2/);
      await expect(newer.query("SELECT name FROM _migrations")).resolves.toBeDefined();
    } finally {
      await newer.query("UPDATE provider_schema_epoch SET epoch=1");
    }
  });

  it("refuses a database whose barrier was weakened", async () => {
    const owner = await connect(migrator, true);
    const verify = () => modules.epoch.verifyCompatibilityBarrier(
      modules.pool.migrationPool, ["provider_transactions", "rate_limit_buckets"],
    );
    await expect(verify()).resolves.toBeUndefined();
    await owner.query("ALTER TABLE rate_limit_buckets DISABLE TRIGGER rate_limit_buckets_runtime_epoch");
    await expect(verify()).rejects.toThrow(/barrier is incomplete: rate_limit_buckets/);
    await owner.query("ALTER TABLE rate_limit_buckets ENABLE TRIGGER rate_limit_buckets_runtime_epoch");
    await owner.query("ALTER TABLE _migrations NO FORCE ROW LEVEL SECURITY");
    await expect(verify()).rejects.toThrow(/barrier is incomplete/);
    await owner.query("ALTER TABLE _migrations FORCE ROW LEVEL SECURITY");
    await expect(verify()).resolves.toBeUndefined();
  });

  it("fails closed when a connection loses the marker", async () => {
    const unmarked = new pg.Pool({ connectionString: databaseUrl(database.name, runtime), max: 1 });
    try {
      await expect(modules.epoch.verifyRuntimeEpochMarker(unmarked)).rejects.toThrow(BARRIER);
    } finally {
      await unmarked.end();
    }
  });
});

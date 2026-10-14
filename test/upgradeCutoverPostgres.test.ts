import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { withRuntimeEpochMarker } from "../src/core/db/runtimeEpoch.js";
import { providerKey } from "./gatewayWire.js";
import {
  createDisposableDatabase,
  createDisposableRole,
  databaseUrl,
  describePostgres,
  type DisposableDatabase,
  type DisposableRole,
} from "./postgresHarness.js";

const baseline = readFileSync(new URL("../src/core/db/migrations/001_initial.sql", import.meta.url), "utf8");

// The operator's stop-and-drain step on a database a pre-R1 image left with
// one interrupted call: inventory first, resolution only on confirmation.
describePostgres("pre-R1 to R1 cutover command", () => {
  let migrator: DisposableRole;
  let runtime: DisposableRole;
  let database: DisposableDatabase;
  let env: NodeJS.ProcessEnv;

  const cutover = (...args: string[]) => spawnSync(
    process.execPath, ["--import=tsx", "src/upgradeCutover.ts", ...args],
    { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000 },
  );
  // Migration log lines precede the report, which is the last line.
  const report = (stdout: string) => JSON.parse(stdout.trim().split("\n").at(-1)!);
  const row = async () => {
    const client = new pg.Client(withRuntimeEpochMarker(databaseUrl(database.name, migrator)));
    await client.connect();
    try {
      return (await client.query("SELECT state,result FROM provider_transactions WHERE id='task-pre-r1'")).rows[0];
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    migrator = await createDisposableRole("lite_cutover_migrator");
    runtime = await createDisposableRole("lite_cutover_runtime");
    database = await createDisposableDatabase("lite_cutover", migrator.name);
    const legacy = new pg.Client({ connectionString: databaseUrl(database.name, migrator) });
    await legacy.connect();
    await legacy.query(`CREATE TABLE _migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await legacy.query(baseline);
    await legacy.query("INSERT INTO _migrations (name, checksum) VALUES ($1, $2)", [
      "001_initial.sql", createHash("sha256").update(baseline).digest("hex"),
    ]);
    await legacy.query(`INSERT INTO provider_transactions (
        id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
        service_slug,skill_id,listing_manifest_hash,state,created_at)
      VALUES ('task-pre-r1','https://gateway.example','ord_pre_r1',decode(repeat('01',32),'hex'),
        decode(repeat('02',32),'hex'),decode(repeat('03',32),'hex'),
        '0x1111111111111111111111111111111111111111','dummy','echo',
        decode(repeat('04',32),'hex'),'executing',now() - interval '10 minutes')`);
    await legacy.end();
    env = {
      PATH: process.env.PATH,
      NODE_ENV: "development",
      BASE_URL: "https://provider.example",
      GATEWAY_BASE_URL: "https://gateway.example",
      PROVIDER_NAME: "Cutover Provider",
      MARKETPLACE_TERMS_URL: "https://marketplace.test/terms",
      MARKETPLACE_PRIVACY_URL: "https://marketplace.test/privacy",
      PROVIDER_TERMS_URL: "https://provider.test/terms",
      PROVIDER_PRIVACY_URL: "https://provider.test/privacy",
      SUPPORT_EMAIL: "support@provider.test",
      DATABASE_URL: databaseUrl(database.name, runtime),
      MIGRATION_DATABASE_URL: databaseUrl(database.name, migrator),
      DATABASE_SSL_MODE: "disable",
      CHAIN_ID: "84532",
      BASE_RPC_URL: "https://rpc.example",
      PROVIDER_WALLET_PRIVATE_KEY: providerKey,
      PROVIDER_AGENT_ID: "8327",
      IDENTITY_REGISTRY_ADDRESS: "0x1111111111111111111111111111111111111111",
      USDC_ADDRESS: "0x6666666666666666666666666666666666666666",
      RATE_LIMIT_HASH_KEY: "testing-only-rate-limit-key-with-entropy-1234567890",
    };
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
    await runtime?.drop();
    await migrator?.drop();
  });

  it("refuses to resolve anything until old processes are confirmed stopped", async () => {
    const refused = cutover("--resolve-legacy");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("requires --old-processes-stopped");
    expect(await row()).toMatchObject({ state: "executing", result: null });
  });

  it("migrates, installs the barrier and inventories the interrupted pre-R1 call", async () => {
    const inventory = cutover();
    expect(inventory.status, inventory.stderr).toBe(0);
    expect(report(inventory.stdout)).toMatchObject({
      inventory: {
        schemaEpoch: 1,
        buildEpoch: 1,
        legacyExecutions: { count: 1, taskIds: ["task-pre-r1"] },
        leasedExecutions: { live: 0, expired: 0 },
      },
    });
    expect(await row()).toMatchObject({ state: "executing", result: null });
  });

  it("resolves the interrupted call as the pre-R1 image would have, once confirmed", async () => {
    const resolved = cutover("--resolve-legacy", "--old-processes-stopped");
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(report(resolved.stdout).resolvedLegacyExecutions).toEqual(["task-pre-r1"]);
    expect(await row()).toEqual({
      state: "failed",
      result: { status: "failed", errorCode: "provider_restarted_during_execution" },
    });
  });
});

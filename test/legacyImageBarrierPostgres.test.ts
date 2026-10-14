import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRuntimeEpochMarker } from "../src/core/db/runtimeEpoch.js";
import { providerKey } from "./gatewayWire.js";
import {
  createDisposableDatabase,
  createDisposableRole,
  databaseTestUrl,
  databaseUrl,
  type DisposableDatabase,
  type DisposableRole,
} from "./postgresHarness.js";
import { buildGlobalPolicyFixture, encodeGlobalPolicy, testGatewaySigner } from "./runtimeCatalogFixture.js";

/**
 * L-T14 against the actual pre-R1 compiled image. Build it outside this
 * checkout (docs/releasing.md) and name its root:
 *   LEGACY_PROVIDER_ROOT=/path/to/provider-1d3fb23 npx vitest run test/legacyImageBarrierPostgres.test.ts
 * Skipped without it, like every PostgreSQL suite without DATABASE_URL_TEST.
 */
const legacyRoot = process.env.LEGACY_PROVIDER_ROOT?.trim() || null;
const describeLegacy = describe.skipIf(
  !databaseTestUrl || !legacyRoot || !existsSync(join(legacyRoot ?? "", "dist/bootstrap.js")),
);
const BARRIER = "provider compatibility barrier";

interface Run { code: number | null; served: boolean; logs: string }

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Run a process until it exits, or stop it once it serves. */
async function run(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Run> {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const logs: string[] = [];
  child.stdout!.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr!.on("data", (chunk) => logs.push(String(chunk)));
  const exited = once(child, "exit");
  const started = Date.now();
  while (child.exitCode === null && !logs.join("").includes("Server listening")) {
    if (Date.now() - started > 45_000) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const served = logs.join("").includes("Server listening");
  if (child.exitCode === null) child.kill("SIGTERM");
  await exited;
  return { code: child.exitCode, served, logs: logs.join("") };
}

describeLegacy("the actual pre-R1 image against an R1 database", () => {
  let migrator: DisposableRole;
  let runtime: DisposableRole;
  const databases: DisposableDatabase[] = [];
  let baseEnv: NodeJS.ProcessEnv;

  async function admin<T>(database: DisposableDatabase, work: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client(withRuntimeEpochMarker(databaseUrl(database.name)));
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  /** Every row of every provider table, and every grant the runtime role holds. */
  const snapshot = (database: DisposableDatabase) => admin(database, async (client) => {
    const parts: string[] = [];
    const tables = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename",
    );
    for (const { tablename } of tables.rows) {
      const rows = await client.query(`SELECT t::text AS row FROM "${tablename}" t ORDER BY 1`);
      parts.push(`${tablename}: ${rows.rows.map((row) => row.row).join(" | ")}`);
    }
    const grants = await client.query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee=$1 ORDER BY 1, 2`, [runtime.name],
    );
    const defaults = await client.query("SELECT defaclacl::text AS acl FROM pg_default_acl ORDER BY 1");
    parts.push(`grants: ${JSON.stringify(grants.rows)} defaults: ${JSON.stringify(defaults.rows)}`);
    return parts.join("\n");
  });

  const env = (database: DisposableDatabase, principals: "owner" | "separate" | "superuser") => ({
    ...baseEnv,
    DATABASE_URL: principals === "superuser" ? databaseUrl(database.name)
      : databaseUrl(database.name, principals === "owner" ? migrator : runtime),
    ...(principals === "separate" ? { MIGRATION_DATABASE_URL: databaseUrl(database.name, migrator) } : {}),
  });
  const legacyBoot = (database: DisposableDatabase, principals: "owner" | "separate" | "superuser") =>
    run(["dist/bootstrap.js"], legacyRoot!, env(database, principals));
  const r1Boot = (database: DisposableDatabase) =>
    run(["--import=tsx", "src/bootstrap.ts"], process.cwd(), env(database, "separate"));

  /** A pre-R1 database made by the pre-R1 image, then upgraded by an R1 boot. */
  async function upgradedDatabase(withExecutingRows: boolean): Promise<DisposableDatabase> {
    const database = await createDisposableDatabase("lite_legacy", migrator.name);
    databases.push(database);
    const control = await legacyBoot(database, "owner");
    expect(control.served, control.logs).toBe(true);
    if (withExecutingRows) {
      const owner = new pg.Client({ connectionString: databaseUrl(database.name, migrator) });
      await owner.connect();
      await owner.query(`INSERT INTO provider_transactions (
          id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
          service_slug,skill_id,listing_manifest_hash,state)
        VALUES ('task-pre-r1','https://gateway.example','ord_pre_r1',decode(repeat('01',32),'hex'),
          decode(repeat('02',32),'hex'),decode(repeat('03',32),'hex'),
          '0x1111111111111111111111111111111111111111','dummy','echo',
          decode(repeat('04',32),'hex'),'executing')`);
      await owner.end();
    }
    const upgrade = await r1Boot(database);
    expect(upgrade.served, upgrade.logs).toBe(true);
    await admin(database, async (client) => {
      await client.query(`INSERT INTO provider_quotes
          (quote_hash,outcome_id,listing_manifest_hash,request_hash,gross_amount,payer,issued_at,valid_before)
        VALUES (decode(repeat('05',32),'hex'),'echo',decode(repeat('04',32),'hex'),
          decode(repeat('06',32),'hex'),'10000',NULL,1000,1120)`);
      if (withExecutingRows) {
        await client.query(`INSERT INTO provider_transactions (
            id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
            service_slug,skill_id,listing_manifest_hash,state,dispatch_valid_before,
            execution_owner,execution_lease_token,execution_lease_expires_at)
          VALUES ('task-r1','https://gateway.example','ord_r1',decode(repeat('07',32),'hex'),
            decode(repeat('08',32),'hex'),decode(repeat('09',32),'hex'),
            '0x1111111111111111111111111111111111111111','dummy','echo',
            decode(repeat('04',32),'hex'),'executing',now() + interval '5 minutes',
            gen_random_uuid(),gen_random_uuid(),now() + interval '1 hour')`);
      }
    });
    return database;
  }

  beforeAll(async () => {
    migrator = await createDisposableRole("lite_legacy_migrator");
    runtime = await createDisposableRole("lite_legacy_runtime");
    const port = await freePort();
    baseEnv = {
      PATH: process.env.PATH,
      NODE_ENV: "development",
      PORT: String(port),
      BASE_URL: `http://127.0.0.1:${port}`,
      GATEWAY_BASE_URL: "https://gateway.example",
      CHAIN_MODE: "mock",
      PROVIDER_NAME: "Legacy Barrier Provider",
      MARKETPLACE_TERMS_URL: "https://marketplace.test/terms",
      MARKETPLACE_PRIVACY_URL: "https://marketplace.test/privacy",
      PROVIDER_TERMS_URL: "https://provider.test/terms",
      PROVIDER_PRIVACY_URL: "https://provider.test/privacy",
      SUPPORT_EMAIL: "support@provider.test",
      DATABASE_SSL_MODE: "disable",
      CHAIN_ID: "84532",
      BASE_RPC_URL: "https://rpc.example",
      PROVIDER_WALLET_PRIVATE_KEY: providerKey,
      PROVIDER_AGENT_ID: "8327",
      IDENTITY_REGISTRY_ADDRESS: "0x1111111111111111111111111111111111111111",
      USDC_ADDRESS: "0x6666666666666666666666666666666666666666",
      RATE_LIMIT_HASH_KEY: "testing-only-rate-limit-key-with-entropy-1234567890",
      STANDARD_RAIL_ENVIRONMENT: "testnet",
      STANDARD_RAIL_GATEWAY_SIGNER: testGatewaySigner,
      STANDARD_RAIL_GATEWAY_ORIGIN: "https://gateway.example",
      STANDARD_RAIL_GATEWAY_AUDIENCE: "https://gateway.example",
      STANDARD_RAIL_GLOBAL_POLICY_JSON: encodeGlobalPolicy(await buildGlobalPolicyFixture()),
      STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH: `0x${"3".repeat(64)}`,
      SANCTIONS_ORACLE_ADDRESS: "0x5555555555555555555555555555555555555555",
      REPUTATION_STORAGE_ADDRESS: "0x4545454545454545454545454545454545454545",
      EAS_ADDRESS: "0x4646464646464646464646464646464646464646",
      EAS_RUNTIME_CODE_HASH: `0x${"f".repeat(64)}`,
      EAS_OUTCOME_SCHEMA_UID: `0x${"e".repeat(64)}`,
    };
  }, 60_000);

  afterAll(async () => {
    for (const database of databases) await database.drop();
    await runtime?.drop();
    await migrator?.drop();
  });

  it("cannot boot under any principal layout, and changes no row or grant", async () => {
    const database = await upgradedDatabase(true);
    const before = await snapshot(database);
    for (const principals of ["owner", "separate", "superuser"] as const) {
      const attempt = await legacyBoot(database, principals);
      expect({ principals, code: attempt.code, served: attempt.served })
        .toEqual({ principals, code: 1, served: false });
      expect(attempt.logs).toContain(`Startup failed: ${BARRIER}`);
      // Row security refuses the owner's first ledger read, before the
      // privilege reset; a superuser bypasses it and is refused at the sweep.
      expect(attempt.logs).toMatch(principals === "superuser"
        ? /at async failInterruptedTransactions/
        : /at async runMigrations/);
      expect(await snapshot(database)).toBe(before);
    }
  }, 180_000);

  it("fails its unconditional startup sweep even when no row is executing", async () => {
    const database = await upgradedDatabase(false);
    const before = await snapshot(database);
    // A superuser bypasses row security, so the old runner passes its ledger
    // read and reaches the sweep, which matches no rows.
    const attempt = await legacyBoot(database, "superuser");
    expect(attempt.served).toBe(false);
    expect(attempt.logs).not.toContain("Marked interrupted synchronous executions");
    expect(attempt.logs).toMatch(/Startup failed: provider compatibility barrier[\s\S]*failInterruptedTransactions/);
    expect(await snapshot(database)).toBe(before);
  }, 180_000);

  it("cannot change R1 rows from code that was already running", async () => {
    const database = await upgradedDatabase(true);
    const before = await snapshot(database);
    const script = `
      const outcomes = {};
      const attempt = async (name, work) => {
        try { await work(); outcomes[name] = "succeeded"; }
        catch (error) { outcomes[name] = String(error.message); }
      };
      const db = await import("./dist/core/db/pool.js");
      const store = await import("./dist/core/standardRail/transactionStore.js");
      const catalog = await import("./dist/core/gatewayRegistration/runtimeCatalog.js");
      const journal = await import("./dist/core/suppliers/operationJournal.js");
      await attempt("sweep", () => db.failInterruptedTransactions());
      await attempt("complete", () => store.completeTransaction("task-r1", { status: "completed" }));
      await attempt("claim", () => store.claimTransaction({
        gatewayAudience: "https://gateway.example", orderId: "ord_old_process",
        dispatchNonce: "0x" + "0a".repeat(32), dispatchHash: "0x" + "0b".repeat(32),
        requestHash: "0x" + "0c".repeat(32), payer: "0x1111111111111111111111111111111111111111",
        serviceSlug: "dummy", skillId: "echo", listingManifestHash: "0x" + "04".repeat(32),
        maxOpenOrders: 10,
      }));
      await attempt("promote", () => catalog.promoteRuntimeListingVersions(
        "https://gateway.example", "0x" + "0d".repeat(32), [{
          listingId: "00000000-0000-4000-8000-000000000001", listingKey: "0x" + "0e".repeat(32),
          skillId: "echo", paymentRequired: true, runtimeCommitmentHash: "0x" + "0f".repeat(32),
          runtimeCommitment: {}, bundle: {},
        }]));
      await attempt("journal", () => journal.beginSupplierOperation({
        serviceId: "dummy", opKey: "old-process", kind: "probe" }));
      process.stdout.write(JSON.stringify(outcomes));
      await db.pool.end();
      await db.closeMigrationPool();
    `;
    const result = await run(["--input-type=module", "-e", script], legacyRoot!, env(database, "owner"));
    const outcomes = JSON.parse(result.logs.slice(result.logs.indexOf("{\"sweep\""))) as Record<string, string>;
    expect(Object.keys(outcomes).sort()).toEqual(["claim", "complete", "journal", "promote", "sweep"]);
    for (const [name, outcome] of Object.entries(outcomes)) {
      expect(`${name}: ${outcome}`).toContain(BARRIER);
    }
    expect(await snapshot(database)).toBe(before);
  }, 180_000);

  it("its privilege-reset routine, run outside its boot path, rewrites only grants that R1 restores", async () => {
    const database = await upgradedDatabase(false);
    const before = await snapshot(database);
    const script = `
      const db = await import("./dist/core/db/pool.js");
      await db.configureRuntimePrivileges();
      await db.closeMigrationPool();
      await db.pool.end();
    `;
    const direct = await run(["--input-type=module", "-e", script], legacyRoot!, env(database, "separate"));
    expect(direct.code).toBe(0);
    const after = await snapshot(database);
    const rows = (value: string) => value.slice(0, value.lastIndexOf("\ngrants:"));
    expect(rows(after)).toBe(rows(before));
    expect(after).not.toBe(before);
    const restored = await r1Boot(database);
    expect(restored.served, restored.logs).toBe(true);
    expect(await snapshot(database)).toBe(before);
  }, 180_000);
});

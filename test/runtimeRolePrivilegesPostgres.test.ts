import pg from "pg";
import type { Hex } from "viem";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createDisposableDatabase,
  createDisposableRole,
  databaseUrl,
  describePostgres,
  type DisposableDatabase,
  type DisposableRole,
} from "./postgresHarness.js";

const ORIGIN = "https://gateway.example";
const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

// L-T19: boot under separate migration and runtime principals, exactly as
// production does, and prove the runtime role can serve while it cannot
// change schema or erase durable state.
describePostgres("runtime role against a separately migrated PostgreSQL schema", () => {
  let migrator: DisposableRole;
  let runtime: DisposableRole;
  let database: DisposableDatabase;
  let modules: {
    pool: typeof import("../src/core/db/pool.js");
    privileges: typeof import("../src/core/db/runtimePrivileges.js");
    catalog: typeof import("../src/core/gatewayRegistration/runtimeCatalog.js");
    transactions: typeof import("../src/core/standardRail/transactionStore.js");
    journal: typeof import("../src/core/suppliers/operationJournal.js");
    quotes: typeof import("../src/core/standardRail/quoteStore.js");
    leases: typeof import("../src/core/standardRail/syncLease.js");
  };

  beforeAll(async () => {
    migrator = await createDisposableRole("lite_migrator");
    runtime = await createDisposableRole("lite_runtime");
    database = await createDisposableDatabase("lite_roles", migrator.name);
    process.env.DATABASE_URL = databaseUrl(database.name, runtime);
    process.env.MIGRATION_DATABASE_URL = databaseUrl(database.name, migrator);
    modules = {
      pool: await import("../src/core/db/pool.js"),
      privileges: await import("../src/core/db/runtimePrivileges.js"),
      catalog: await import("../src/core/gatewayRegistration/runtimeCatalog.js"),
      transactions: await import("../src/core/standardRail/transactionStore.js"),
      journal: await import("../src/core/suppliers/operationJournal.js"),
      quotes: await import("../src/core/standardRail/quoteStore.js"),
      leases: await import("../src/core/standardRail/syncLease.js"),
    };
    await modules.pool.runMigrations();
    await modules.pool.configureRuntimePrivileges();
    await modules.pool.verifyDatabaseRoleSeparation();
    await modules.catalog.promoteRuntimeListingVersions(ORIGIN, hash("1"), [{
      listingId: "00000000-0000-4000-8000-000000000001",
      listingKey: hash("2"),
      skillId: "echo",
      paymentRequired: true,
      runtimeCommitmentHash: hash("3"),
      runtimeCommitment: {} as never,
      bundle: {} as never,
    }], modules.pool.migrationPool);
  });

  afterAll(async () => {
    await modules?.pool.closeMigrationPool().catch(() => undefined);
    await modules?.pool.pool.end().catch(() => undefined);
    await database?.drop();
    await runtime?.drop();
    await migrator?.drop();
  });

  it("reads the promoted runtime catalog at boot", async () => {
    const heads = await modules.catalog.loadRuntimeListingHeads(ORIGIN);
    expect(heads.map((head) => head.skillId)).toEqual(["echo"]);
  });

  it("grants exactly the reviewed privileges on every migrated table", async () => {
    const { pool } = modules.pool;
    const tables = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename",
    );
    const reviewed = modules.privileges.RUNTIME_TABLE_PRIVILEGES;
    expect(tables.rows.map((row) => row.tablename).sort())
      .toEqual(["_migrations", ...Object.keys(reviewed)].sort());
    for (const { tablename } of tables.rows) {
      const granted: string[] = [];
      for (const privilege of PRIVILEGES) {
        const result = await pool.query<{ allowed: boolean }>(
          "SELECT has_table_privilege(current_user, $1, $2) AS allowed",
          [tablename, privilege],
        );
        if (result.rows[0]?.allowed) granted.push(privilege);
      }
      expect({ tablename, granted })
        .toEqual({ tablename, granted: [...(reviewed[tablename] ?? [])] });
    }
  });

  it("runs the ledger, quote, journal, and rate-limit statements as the runtime role", async () => {
    const quote = {
      outcomeId: "echo",
      listingManifestHash: hash("3"),
      requestHash: hash("6"),
      grossAmount: "10000",
      payer: null,
      issuedAt: 1_000,
      validBefore: 1_120,
    };
    const quoteHash = await modules.quotes.persistProviderQuote(quote);
    await expect(modules.quotes.loadProviderQuote(quoteHash)).resolves.toEqual(quote);
    await expect(modules.quotes.countOpenObligations(hash("3"))).resolves.toBe(0);
    const claimed = await modules.transactions.claimTransaction({
      gatewayAudience: ORIGIN,
      orderId: "ord_00000000-0000-4000-8000-000000000001",
      dispatchNonce: hash("4"),
      dispatchHash: hash("5"),
      requestHash: hash("6"),
      payer: `0x${"77".repeat(20)}` as Hex,
      serviceSlug: "dummy",
      skillId: "echo",
      listingManifestHash: hash("3"),
      dispatchValidBefore: Math.floor(Date.now() / 1_000) + 300,
    });
    await expect(modules.leases.renewSyncLease(
      claimed.transaction.id, claimed.transaction.execution_lease_token!,
    )).resolves.toBe(true);
    await expect(modules.transactions.completeTransaction(
      claimed.transaction.id, claimed.transaction.execution_lease_token!, { status: "completed" },
    )).resolves.toMatchObject({ state: "completed" });
    await expect(modules.leases.sweepAbandonedSyncExecutions()).resolves.toEqual([]);
    const operation = await modules.journal.beginSupplierOperation({
      serviceId: "dummy",
      opKey: "role-check",
      kind: "probe",
    });
    await modules.journal.confirmSupplierOperation(operation.op.id, { ok: true });
    await modules.pool.pool.query(
      `INSERT INTO rate_limit_buckets (bucket_key,tokens,last_refill,expires_at)
       VALUES ('role-check',1,now(),now()) ON CONFLICT (bucket_key) DO UPDATE SET tokens=0`,
    );
    await modules.pool.pool.query(
      `INSERT INTO standard_evidence_admissions (
         evidence_hash,order_id,evidence_kind,transaction_hash,block_number,block_hash,
         authorization_key,release_sequence,transaction_index,log_index,
         source_fingerprints,canonical_evidence)
       VALUES (decode(repeat('88',32),'hex'),'role-check','deposit',$1,1,$1,
         decode(repeat('99',32),'hex'),NULL,0,1,'[]','{}')
       ON CONFLICT (evidence_hash) DO UPDATE SET evidence_hash=EXCLUDED.evidence_hash`,
      [hash("a")],
    );
  });

  it("denies runtime DDL, destructive writes, catalog writes, and migration-ledger access", async () => {
    const denied = async (sql: string) => {
      await expect(modules.pool.pool.query(sql)).rejects.toThrow(/permission denied|must be owner/);
    };
    await denied("CREATE TABLE runtime_owned (id INTEGER)");
    await denied("CREATE TEMP TABLE runtime_scratch (id INTEGER)");
    await denied("DELETE FROM provider_transactions");
    await denied("TRUNCATE rate_limit_buckets");
    await denied("DROP TABLE supplier_operations");
    await denied("ALTER TABLE provider_transactions ADD COLUMN extra TEXT");
    await denied("UPDATE provider_runtime_listing_versions SET superseded_at=now()");
    await denied("DELETE FROM provider_runtime_listing_versions");
    await denied("SELECT * FROM _migrations");
    await denied("UPDATE provider_quotes SET gross_amount='1'");
    await denied("DELETE FROM provider_quotes");
    await expect(modules.catalog.promoteRuntimeListingVersions(ORIGIN, hash("1"), [{
      listingId: "00000000-0000-4000-8000-000000000002",
      listingKey: hash("2"),
      skillId: "echo",
      paymentRequired: true,
      runtimeCommitmentHash: hash("b"),
      runtimeCommitment: {} as never,
      bundle: {} as never,
    }])).rejects.toThrow(/permission denied/);
  });

  it("keeps the runtime principal unable to own or create schema objects", async () => {
    const owner = new pg.Client({ connectionString: databaseUrl(database.name, migrator) });
    await owner.connect();
    try {
      const owned = await owner.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname=current_schema() AND pg_get_userbyid(c.relowner)=$1`,
        [runtime.name],
      );
      expect(owned.rows[0]?.count).toBe(0);
    } finally {
      await owner.end();
    }
  });
});

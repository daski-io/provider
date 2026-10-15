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
import { jobKeys } from "./externalJobFixture.js";

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
    admission: typeof import("../src/core/externalJobs/admission.js");
    claims: typeof import("../src/core/externalJobs/jobClaims.js");
    transitions: typeof import("../src/core/externalJobs/jobTransitions.js");
    codec: typeof import("../src/core/externalJobs/jobCodec.js");
    handoff: typeof import("../src/core/externalJobs/journalHandoff.js");
    health: typeof import("../src/core/externalJobs/health.js");
    servicing: typeof import("../src/core/externalJobs/servicing.js");
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
      admission: await import("../src/core/externalJobs/admission.js"),
      claims: await import("../src/core/externalJobs/jobClaims.js"),
      transitions: await import("../src/core/externalJobs/jobTransitions.js"),
      codec: await import("../src/core/externalJobs/jobCodec.js"),
      handoff: await import("../src/core/externalJobs/journalHandoff.js"),
      health: await import("../src/core/externalJobs/health.js"),
      servicing: await import("../src/core/externalJobs/servicing.js"),
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
    const quoteHash = await modules.quotes.persistProviderQuote(quote, 900, null);
    await expect(modules.quotes.loadProviderQuote(quoteHash)).resolves.toEqual({ ...quote, adapterVersion: null });
    // An external-job sale records the adapter version that sold it.
    const sold = { ...quote, requestHash: hash("8") };
    const soldHash = await modules.quotes.persistProviderQuote(sold, 900, "v1");
    await expect(modules.quotes.loadProviderQuote(soldHash)).resolves.toEqual({ ...sold, adapterVersion: "v1" });
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
      providerQuoteHash: quoteHash,
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

  it("runs the external-job admission, worker, journal and health statements as the runtime role", async () => {
    const keys = jobKeys();
    const admitted = await modules.transactions.claimTransaction({
      gatewayAudience: ORIGIN,
      orderId: "ord_00000000-0000-4000-8000-0000000000e1",
      dispatchNonce: hash("e"),
      dispatchHash: hash("5"),
      requestHash: hash("6"),
      payer: `0x${"77".repeat(20)}` as Hex,
      serviceSlug: "dummy",
      skillId: "echo",
      listingManifestHash: hash("3"),
      dispatchValidBefore: Math.floor(Date.now() / 1_000) + 300,
      providerQuoteHash: hash("7"),
      execution: {
        kind: "external-job",
        insertJob: (client, taskId) => modules.admission.insertExternalJob(client, keys, taskId, {
          serviceSlug: "dummy", adapterVersion: "v1", idempotencyKey: "00000000-0000-8000-8000-0000000000e1",
          fulfillmentSeconds: 43_200, input: { message: "hello" },
        }),
      },
    });
    expect(admitted.transaction.state).toBe("external_job");
    const claim = () => modules.claims.claimDueJobs({
      owner: "00000000-0000-4000-8000-0000000000e2", gatewayAudience: ORIGIN, limit: 1, leaseSeconds: 30,
      maxConcurrentCalls: 4, serviceable: [{ serviceSlug: "dummy", adapterVersion: "v1" }],
    });
    const [queued] = await claim();
    await expect(modules.claims.renewJobLease(queued!, 30)).resolves.toBe(true);
    const intent = await modules.transitions.recordStartIntent({
      job: queued!, from: "queued", retentionSeconds: 3_600, leaseSeconds: 30,
    });
    // An ambiguous start, then a settled restart under the same journal entry.
    const first = { ...queued!, ...intent! };
    await expect(modules.transitions.fenced(first, "starting", (client) => modules.transitions.updateJob(client, first, {
      phase: "reconciling", delaySeconds: 0, failures: "increment", errorCode: "start.timeout",
      journal: { ambiguous: "timeout" },
    }))).resolves.toBe("committed");
    await expect(modules.handoff.startSettlesIn(modules.pool.pool, first, 0)).resolves.toBe(0);
    const [reconciling] = await claim();
    const restarted = await modules.transitions.recordStartIntent({
      job: reconciling!, from: "reconciling", retentionSeconds: 3_600, leaseSeconds: 30,
      restart: { basis: "authoritative-absence", replayMarginSeconds: 0, settleSeconds: 0 },
    });
    expect(restarted?.journalOperationId).toBe(intent!.journalOperationId);
    const started = { ...reconciling!, ...restarted! };
    await expect(modules.transitions.fenced(started, "starting", (client) => modules.transitions.updateJob(client, started, {
      phase: "polling", reference: modules.codec.sealJobField(keys, "reference", started, { jobId: "j" }),
      delaySeconds: 0, failures: "reset", errorCode: null, journal: "confirmed",
    }))).resolves.toBe("committed");
    await expect(modules.handoff.replayStartJournal(modules.pool.pool, keys, started))
      .resolves.toMatchObject({ state: "confirmed", reference: { jobId: "j" } });
    const [polling] = await claim();
    await expect(modules.transitions.finishJob(polling!, "polling", { status: "completed" })).resolves.toBe("committed");
    await expect(modules.health.inspectExternalJobs(modules.pool.pool, {
      adapterVersions: () => new Set(["v1"]), keyIds: new Set(["k1"]), canSeal: true,
    }, 30, ORIGIN)).resolves.toMatchObject({ active: 0 });
    await expect(modules.servicing.verifyLiveExternalJobSales(modules.pool.pool, [])).resolves.toBeUndefined();
    await modules.pool.pool.query(
      "UPDATE provider_runtime_instances SET worker_heartbeat_at=now() WHERE instance_id=gen_random_uuid()",
    );
    await expect(modules.pool.pool.query("DELETE FROM provider_external_jobs")).rejects.toThrow(/permission denied/);
    await expect(modules.pool.pool.query("TRUNCATE provider_external_jobs")).rejects.toThrow(/permission denied/);
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
    await denied("UPDATE provider_quotes SET adapter_version='v2'");
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

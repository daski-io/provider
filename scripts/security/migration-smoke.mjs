import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const { runMigrations, closeMigrationPool, pool } = await import("../../dist/core/db/pool.js");
const {
  claimDurableJob,
  completeDurableJob,
  enqueueDurableJob,
  failDurableJob,
  renewDurableJobLease,
} = await import("../../dist/core/db/queries/durableJobs.js");
const { registerService } = await import("../../dist/core/serviceRegistry/registry.js");
const { installProviderScreening } = await import("../../dist/providerScreening.js");
const { providerServices } = await import("../../dist/providerServices.js");

async function verifyConfirmationPayloadUpgrade() {
  const schema = `confirmation_upgrade_${randomUUID().replaceAll("-", "")}`;
  const liveId = randomUUID();
  const historicalId = randomUUID();
  const encryptedId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query(
      `CREATE TABLE operator_confirmation_intents (
         id UUID PRIMARY KEY,
         action_name TEXT NOT NULL,
         target_type TEXT NOT NULL,
         target_id TEXT NOT NULL,
         pending_payload JSONB NOT NULL DEFAULT '{}',
         pending_payload_encrypted TEXT,
         consumed_at TIMESTAMPTZ,
         voided_at TIMESTAMPTZ,
         execution_status TEXT NOT NULL DEFAULT 'not_started',
         execution_finished_at TIMESTAMPTZ,
         execution_error_code TEXT,
         execution_error_summary TEXT
       )`,
    );
    await client.query(
      `INSERT INTO operator_confirmation_intents(
         id, action_name, target_type, target_id, pending_payload,
         pending_payload_encrypted, consumed_at
       ) VALUES
         ($1,'live.action','asset','live-target',$4,NULL,NULL),
         ($2,'historical.action','asset','historical-target',$4,NULL,now()),
         ($3,'encrypted.action','asset','encrypted-target',$4,'daski:v1:test',NULL)`,
      [liveId, historicalId, encryptedId, JSON.stringify({ secret: "legacy-secret" })],
    );
    const migration = await readFile(
      "dist/core/db/migrations/036_confirmation_payload_confidentiality.sql",
      "utf8",
    );
    await client.query(migration);

    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'operator_confirmation_intents'`,
      [schema],
    );
    const names = new Set(columns.rows.map((row) => row.column_name));
    if (names.has("pending_payload") || !names.has("payload_purged_at")) {
      throw new Error("confirmation payload upgrade did not remove its plaintext column");
    }
    const rows = await client.query(
      `SELECT id, action_name, target_id, pending_payload_encrypted,
              consumed_at, voided_at, execution_status
         FROM operator_confirmation_intents
        ORDER BY action_name`,
    );
    const live = rows.rows.find((row) => row.id === liveId);
    const historical = rows.rows.find((row) => row.id === historicalId);
    const encrypted = rows.rows.find((row) => row.id === encryptedId);
    if (!live?.voided_at || live.execution_status !== "failed") {
      throw new Error("unencrypted live confirmation survived the upgrade");
    }
    if (
      historical?.action_name !== "historical.action"
      || historical.target_id !== "historical-target"
      || !historical.consumed_at
    ) {
      throw new Error("confirmation upgrade discarded safe historical metadata");
    }
    if (encrypted?.voided_at || encrypted?.pending_payload_encrypted !== "daski:v1:test") {
      throw new Error("encrypted live confirmation was invalidated by the upgrade");
    }

    await client.query("SAVEPOINT invalid_live_payload");
    let rejected = false;
    try {
      await client.query(
        `INSERT INTO operator_confirmation_intents(
           id, action_name, target_type, target_id, pending_payload_encrypted
         ) VALUES ($1,'invalid.action','asset','invalid-target',NULL)`,
        [randomUUID()],
      );
    } catch {
      rejected = true;
      await client.query("ROLLBACK TO SAVEPOINT invalid_live_payload");
    }
    if (!rejected) throw new Error("confirmation payload upgrade left live plaintext authority");
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function verifySupplierDiagnosticUpgrade() {
  const schema = `supplier_diagnostic_${randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query(
      `CREATE TABLE supplier_operations (
         id UUID PRIMARY KEY,
         state TEXT NOT NULL,
         error TEXT
       )`,
    );
    await client.query(
      `INSERT INTO supplier_operations(id, state, error) VALUES
         ($1, 'ambiguous', 'buyer-secret@example.test'),
         ($2, 'failed', '/private/supplier/path'),
         ($3, 'confirmed', 'historical noise')`,
      [randomUUID(), randomUUID(), randomUUID()],
    );
    const migration = await readFile(
      "dist/core/db/migrations/037_supplier_operation_error_codes.sql",
      "utf8",
    );
    await client.query(migration);

    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'supplier_operations'`,
      [schema],
    );
    const names = new Set(columns.rows.map((row) => row.column_name));
    if (names.has("error") || !names.has("error_code")) {
      throw new Error("supplier diagnostic upgrade retained its plaintext column");
    }
    const rows = await client.query(
      "SELECT state, error_code FROM supplier_operations ORDER BY state",
    );
    const codes = Object.fromEntries(
      rows.rows.map((row) => [row.state, row.error_code]),
    );
    if (
      codes.ambiguous !== "legacy.ambiguous"
      || codes.failed !== "legacy.failed"
      || codes.confirmed !== null
    ) {
      throw new Error("supplier diagnostic upgrade did not map legacy states");
    }

    await client.query("SAVEPOINT invalid_error_code");
    let rejected = false;
    try {
      await client.query(
        "UPDATE supplier_operations SET error_code = 'raw supplier message'",
      );
    } catch {
      rejected = true;
      await client.query("ROLLBACK TO SAVEPOINT invalid_error_code");
    }
    if (!rejected) {
      throw new Error("supplier diagnostic error-code constraint was not enforced");
    }
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function verifyDurableJobFencing() {
  const queue = `migration-smoke-${randomUUID()}`;
  const job = await enqueueDurableJob({
    queue,
    idempotencyKey: "same-worker-reclaim",
    payload: { smoke: true },
    maxAttempts: 2,
  });
  const first = await claimDurableJob({ queue, workerId: "same-worker", leaseSeconds: 30 });
  if (!first || first.attempts !== 1) throw new Error("first durable-job claim failed");

  await pool.query(
    "UPDATE durable_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [job.id],
  );
  const second = await claimDurableJob({ queue, workerId: "same-worker", leaseSeconds: 30 });
  if (!second || second.attempts !== 2 || second.lease_token === first.lease_token) {
    throw new Error("same-worker durable-job reclaim was not uniquely fenced");
  }

  const staleClaim = { id: job.id, workerId: "same-worker", leaseToken: first.lease_token };
  if (await completeDurableJob(staleClaim)) {
    throw new Error("stale durable-job claim completed after same-worker reclaim");
  }
  if (await renewDurableJobLease({ ...staleClaim, leaseSeconds: 30 })) {
    throw new Error("stale durable-job claim renewed after same-worker reclaim");
  }
  if (await failDurableJob({
    ...staleClaim,
    error: "stale crash",
    retryAt: new Date(),
  }) !== null) {
    throw new Error("stale durable-job claim failed a newer claim");
  }

  await pool.query(
    "UPDATE durable_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [job.id],
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await claimDurableJob({ queue, workerId: "same-worker", leaseSeconds: 30 })) {
      throw new Error("expired durable job exceeded its retry budget");
    }
  }
  const exhausted = await pool.query(
    "SELECT status, attempts, lease_owner, lease_token, lease_expires_at FROM durable_jobs WHERE id = $1",
    [job.id],
  );
  const row = exhausted.rows[0];
  if (
    row.status !== "dead_letter"
    || row.attempts !== 2
    || row.lease_owner !== null
    || row.lease_token !== null
    || row.lease_expires_at !== null
  ) {
    throw new Error("expired durable job was not terminally dead-lettered");
  }
}

try {
  await runMigrations();
  await installProviderScreening();
  for (const service of providerServices) {
    await registerService(service);
  }
  const core = await pool.query("SELECT count(*)::int AS n FROM _migrations WHERE checksum IS NULL");
  const serviceLedger = await pool.query(
    "SELECT to_regclass('_service_migrations') AS table_name",
  );
  const missingServiceChecksums = serviceLedger.rows[0]?.table_name
    ? Number((await pool.query(
      "SELECT count(*)::int AS n FROM _service_migrations WHERE checksum IS NULL",
    )).rows[0].n)
    : 0;
  if (Number(core.rows[0].n) !== 0 || missingServiceChecksums !== 0) {
    throw new Error("migration checksum evidence is incomplete");
  }
  await verifyConfirmationPayloadUpgrade();
  await verifySupplierDiagnosticUpgrade();
  await verifyDurableJobFencing();
  process.stdout.write("core and service migration smoke passed\n");
} finally {
  await closeMigrationPool();
  await pool.end();
}

import { randomUUID } from "node:crypto";

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

async function verifyBaselineSecuritySchema() {
  const columns = await pool.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'operator_confirmation_intents',
          'supplier_operations'
        )`,
  );
  const confirmationColumns = new Set(
    columns.rows
      .filter((row) => row.table_name === "operator_confirmation_intents")
      .map((row) => row.column_name),
  );
  const supplierColumns = new Set(
    columns.rows
      .filter((row) => row.table_name === "supplier_operations")
      .map((row) => row.column_name),
  );
  if (
    confirmationColumns.has("pending_payload")
    || !confirmationColumns.has("pending_payload_encrypted")
    || !confirmationColumns.has("payload_purged_at")
  ) {
    throw new Error("fresh baseline exposes an unsafe confirmation payload schema");
  }
  if (supplierColumns.has("error") || !supplierColumns.has("error_code")) {
    throw new Error("fresh baseline exposes an unsafe supplier diagnostic schema");
  }

  const service = await pool.query(
    "SELECT id FROM services WHERE is_active = true ORDER BY created_at, id LIMIT 1",
  );
  if (!service.rows[0]?.id) {
    throw new Error("fresh baseline smoke requires one registered active service");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SAVEPOINT invalid_live_payload");
    let livePayloadRejected = false;
    try {
      await client.query(
        `INSERT INTO operator_confirmation_intents(
           id, operator_wallet, thread_id, action_name, arguments_hash,
           target_type, target_id, expires_at, pending_payload_encrypted
         ) VALUES (
           $1, '0x0000000000000000000000000000000000000001', $2,
           'invalid.action', $3, 'asset', 'invalid-target',
           now() + interval '5 minutes', NULL
         )`,
        [randomUUID(), randomUUID(), Buffer.alloc(32)],
      );
    } catch {
      livePayloadRejected = true;
      await client.query("ROLLBACK TO SAVEPOINT invalid_live_payload");
    }
    if (!livePayloadRejected) {
      await client.query("ROLLBACK TO SAVEPOINT invalid_live_payload");
      throw new Error("fresh baseline accepts live plaintext confirmation authority");
    }

    await client.query("SAVEPOINT invalid_supplier_error_code");
    let supplierErrorRejected = false;
    try {
      await client.query(
        `INSERT INTO supplier_operations(
           id, service_id, op_key, kind, error_code
         ) VALUES ($1, $2, $3, 'smoke', 'raw supplier message')`,
        [randomUUID(), service.rows[0].id, `smoke:${randomUUID()}`],
      );
    } catch {
      supplierErrorRejected = true;
      await client.query("ROLLBACK TO SAVEPOINT invalid_supplier_error_code");
    }
    if (!supplierErrorRejected) {
      await client.query("ROLLBACK TO SAVEPOINT invalid_supplier_error_code");
      throw new Error("fresh baseline accepts an unbounded supplier diagnostic");
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
  await verifyBaselineSecuritySchema();
  await verifyDurableJobFencing();
  process.stdout.write("core and service migration smoke passed\n");
} finally {
  await closeMigrationPool();
  await pool.end();
}

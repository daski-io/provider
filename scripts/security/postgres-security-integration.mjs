import { randomUUID } from "node:crypto";

const { pool, closeMigrationPool } = await import("../../dist/core/db/pool.js");
const {
  createSession,
  getActiveSession,
  deleteSession,
} = await import("../../dist/core/db/queries/sessions.js");
const {
  getOrCreateFreeFormThread,
} = await import("../../dist/core/db/queries/chatThreads.js");
const {
  appendOperatorChatMessage,
} = await import("../../dist/core/db/queries/operatorChats.js");
const {
  createConfirmationIntent,
  consumeApprovedConfirmationIntent,
} = await import("../../dist/core/db/queries/confirmationIntents.js");
const {
  approveConfirmationIntent,
} = await import("../../dist/core/db/queries/confirmationIntentApprovals.js");
const {
  claimDurableJob,
  completeDurableJob,
  enqueueDurableJob,
  failDurableJob,
} = await import("../../dist/core/db/queries/durableJobs.js");
const { runRetention } = await import("../../dist/core/db/retention.js");
const { emitEvent } = await import("../../dist/core/events/emitter.js");
const { placeLegalHold, releaseLegalHold } = await import("../../dist/core/legalHold/commands.js");
const { encryptString } = await import("../../dist/core/chain/encryption.js");
const { withProviderSignerLease } = await import("../../dist/core/chain/signerLease.js");
const {
  lockComplianceRefundMutations,
  withComplianceRefundLease,
} = await import("../../dist/core/compliance/lease.js");
const { verifySupplierOperationDiagnostics } = await import(
  "./postgres-supplier-diagnostics.mjs"
);
const { verifyStandardEvidenceLocatorIndex } = await import(
  "./postgres-standard-evidence-locator.mjs"
);
const { scanProtectedData } = await import("../../dist/core/security/protectedDataRotation.js");
const { registerServiceProtectedData } = await import(
  "../../dist/core/security/protectedDataSinks.js"
);
const { registerProviderScreeningProtectedData } = await import("../../dist/providerScreening.js");
const { providerServices } = await import("../../dist/providerServices.js");

registerProviderScreeningProtectedData();
for (const service of providerServices) registerServiceProtectedData(service);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertNoSingleKeyAdvisoryLock(lockName, message) {
  const remaining = await pool.query(
    `SELECT 1
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND granted
        AND objsubid = 1
        AND objid::int = hashtext($1)`,
    [lockName],
  );
  assert(remaining.rowCount === 0, message);
}

async function verifyProviderSignerLease() {
  const scope = {
    chainId: 8453,
    walletAddress: "0x1212121212121212121212121212121212121212",
  };
  const lockName =
    `daski:provider-wallet-signer:v2:${scope.chainId}:${scope.walletAddress}`;
  let active = 0;
  let maxActive = 0;
  const enter = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 300));
    active -= 1;
  };

  await Promise.all([
    withProviderSignerLease(scope, enter, 5_000),
    withProviderSignerLease(scope, enter, 5_000),
  ]);
  assert(maxActive === 1, "provider signer lease did not serialize independent sessions");

  let protectedFailure = false;
  try {
    await withProviderSignerLease(scope, async () => {
      throw new Error("controlled signer callback failure");
    }, 5_000);
  } catch (error) {
    protectedFailure = error?.message === "controlled signer callback failure";
  }
  assert(protectedFailure, "provider signer lease replaced the protected callback failure");
  await withProviderSignerLease(scope, async () => undefined, 5_000);
  await assertNoSingleKeyAdvisoryLock(
    lockName,
    "provider signer lease remained held after callback cleanup",
  );
}

async function verifyComplianceRefundLease() {
  const lockName = "daski:compliance-refunds:v1";
  let active = 0;
  let maxActive = 0;
  let sessionEntered;
  const entered = new Promise((resolve) => {
    sessionEntered = resolve;
  });
  const sessionLease = withComplianceRefundLease(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    sessionEntered();
    await new Promise((resolve) => setTimeout(resolve, 300));
    active -= 1;
  });
  await entered;

  const transactionClient = await pool.connect();
  const transactionLease = (async () => {
    try {
      await transactionClient.query("BEGIN");
      await lockComplianceRefundMutations(transactionClient);
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      await transactionClient.query("COMMIT");
    } catch (error) {
      await transactionClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      transactionClient.release();
    }
  })();
  await Promise.all([sessionLease, transactionLease]);
  assert(
    maxActive === 1,
    "compliance transaction and refund session lease overlapped",
  );

  let protectedFailure = false;
  try {
    await withComplianceRefundLease(async () => {
      throw new Error("controlled compliance callback failure");
    });
  } catch (error) {
    protectedFailure =
      error?.message === "controlled compliance callback failure";
  }
  assert(
    protectedFailure,
    "compliance/refund lease replaced the protected callback failure",
  );
  for (let cycle = 0; cycle < 5; cycle += 1) {
    await withComplianceRefundLease(async () => undefined);
  }
  await assertNoSingleKeyAdvisoryLock(
    lockName,
    "compliance/refund lease count increased after repeated cleanup",
  );
}

const wallet = "0x1212121212121212121212121212121212121212";
try {
  await verifyProviderSignerLease();
  await verifyComplianceRefundLease();
  await verifySupplierOperationDiagnostics();
  await verifyStandardEvidenceLocatorIndex(pool);

  const created = await createSession(wallet, new Date(Date.now() + 60_000));
  assert(!JSON.stringify(created.session).includes(created.token), "database session row exposed bearer token");
  assert((await getActiveSession(created.token))?.id === created.session.id, "opaque session lookup failed");
  await deleteSession(created.token);
  assert(!(await getActiveSession(created.token)), "logout did not revoke bearer");

  const session = await createSession(wallet, new Date(Date.now() + 60_000));
  const thread = await getOrCreateFreeFormThread(wallet);
  const origin = await appendOperatorChatMessage({
    threadId: thread.id, walletAddress: wallet, role: "operator", content: "preview",
  });
  const turnA = await appendOperatorChatMessage({
    threadId: thread.id, walletAddress: wallet, role: "operator", content: "approve A",
  });
  const turnB = await appendOperatorChatMessage({
    threadId: thread.id, walletAddress: wallet, role: "operator", content: "approve B",
  });
  const base = {
    operatorWallet: wallet,
    sessionId: session.session.id,
    threadId: thread.id,
    actionName: "security.integration",
    arguments: { amount: "1" },
    targetType: "test",
    targetId: "race",
  };
  const intent = await createConfirmationIntent(
    { ...base, turnId: origin.id },
    { reason: "CONFIRMATION_SECRET_SENTINEL" },
  );
  const plaintextColumn = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'operator_confirmation_intents'
        AND column_name = 'pending_payload'`,
  );
  assert(plaintextColumn.rowCount === 0, "plaintext confirmation payload column remains");
  const encryptedIntent = await pool.query(
    `SELECT pending_payload_encrypted
       FROM operator_confirmation_intents
      WHERE id = $1`,
    [intent.id],
  );
  assert(
    typeof encryptedIntent.rows[0]?.pending_payload_encrypted === "string"
      && !encryptedIntent.rows[0].pending_payload_encrypted.includes("CONFIRMATION_SECRET_SENTINEL"),
    "confirmation payload was not encrypted at rest",
  );
  assert((await approveConfirmationIntent({
    intentId: intent.id,
    operatorWallet: wallet,
    sessionId: session.session.id,
    threadId: thread.id,
  })).ok, "human confirmation approval failed");
  const raced = await Promise.all([
    consumeApprovedConfirmationIntent({ ...base, turnId: turnA.id }),
    consumeApprovedConfirmationIntent({ ...base, turnId: turnB.id }),
  ]);
  assert(raced.filter(Boolean).length === 1, "confirmation race was not single-use");
  assert(raced.some((result) => result === null), "replayed confirmation was accepted");
  await pool.query(
    `UPDATE operator_confirmation_intents
        SET execution_status = 'succeeded',
            execution_finished_at = now() - interval '4000 days'
      WHERE id = $1`,
    [intent.id],
  );
  await runRetention();
  const purgedIntent = await pool.query(
    `SELECT pending_payload_encrypted, payload_purged_at
       FROM operator_confirmation_intents
      WHERE id = $1`,
    [intent.id],
  );
  assert(
    purgedIntent.rows[0]?.pending_payload_encrypted === null
      && purgedIntent.rows[0]?.payload_purged_at,
    "terminal confirmation ciphertext was not purged",
  );

  const corruptIntent = await createConfirmationIntent(
    { ...base, targetId: "corrupt", turnId: turnA.id },
    { reason: "must never execute" },
  );
  assert((await approveConfirmationIntent({
    intentId: corruptIntent.id,
    operatorWallet: wallet,
    sessionId: session.session.id,
    threadId: thread.id,
  })).ok, "corrupt-payload confirmation approval failed");
  await pool.query(
    `UPDATE operator_confirmation_intents
        SET pending_payload_encrypted = 'corrupt'
      WHERE id = $1`,
    [corruptIntent.id],
  );
  let corruptRejected = false;
  try {
    await consumeApprovedConfirmationIntent({
      ...base,
      targetId: "corrupt",
      turnId: turnB.id,
    });
  } catch (error) {
    corruptRejected = error?.name === "ConfirmationPayloadIntegrityError";
  }
  assert(corruptRejected, "corrupt confirmation ciphertext did not fail closed");
  const corruptState = await pool.query(
    `SELECT consumed_at, voided_at
       FROM operator_confirmation_intents
      WHERE id = $1`,
    [corruptIntent.id],
  );
  assert(
    corruptState.rows[0]?.consumed_at === null && corruptState.rows[0]?.voided_at,
    "corrupt confirmation intent was consumed or left executable",
  );

  const job = await enqueueDurableJob({
    queue: "security-integration",
    idempotencyKey: "lease-race",
    payload: { taskId: "test", email: "PII_SENTINEL@example.com" },
    maxAttempts: 2,
  });
  const claims = await Promise.all([
    claimDurableJob({ queue: "security-integration", workerId: "worker-a", leaseSeconds: 30 }),
    claimDurableJob({ queue: "security-integration", workerId: "worker-b", leaseSeconds: 30 }),
  ]);
  const claimed = claims.filter(Boolean);
  assert(claimed.length === 1 && claimed[0].id === job.id, "durable job was claimed more than once");
  const claim = claimed[0];
  assert(!(await completeDurableJob({
    id: claim.id,
    workerId: "wrong-worker",
    leaseToken: claim.lease_token,
  })), "lease fencing accepted the wrong worker");
  await failDurableJob({
    id: claim.id,
    workerId: claim.lease_owner,
    leaseToken: claim.lease_token,
    error: "Bearer SECRET_SENTINEL https://rpc.example/v2/RPC_SENTINEL?token=QUERY_SENTINEL",
    retryAt: new Date(Date.now() + 60_000),
  });
  const storedJob = await pool.query("SELECT payload, last_error FROM durable_jobs WHERE id = $1", [job.id]);
  const serialized = JSON.stringify(storedJob.rows[0]);
  for (const sentinel of ["PII_SENTINEL", "SECRET_SENTINEL", "RPC_SENTINEL", "QUERY_SENTINEL"]) {
    assert(!serialized.includes(sentinel), `durable queue persisted ${sentinel}`);
  }

  const held = await appendOperatorChatMessage({
    threadId: thread.id, walletAddress: wallet, role: "operator", content: "held evidence",
  });
  const expired = await appendOperatorChatMessage({
    threadId: thread.id, walletAddress: wallet, role: "operator", content: "expired evidence",
  });
  await pool.query(
    `UPDATE operator_chats SET created_at = now() - interval '4000 days', legal_hold = (id = $1)
      WHERE id = ANY($2::uuid[])`,
    [held.id, [held.id, expired.id]],
  );
  await runRetention();
  const retained = await pool.query("SELECT id FROM operator_chats WHERE id = ANY($1::uuid[])", [
    [held.id, expired.id],
  ]);
  assert(retained.rows.some((row) => row.id === held.id), "legal-held operator evidence was deleted");
  assert(!retained.rows.some((row) => row.id === expired.id), "expired operator evidence was retained");

  const service = await pool.query("SELECT id FROM services ORDER BY created_at LIMIT 1");
  // Post-cutover these synthetic rows are class-1 anonymous transactions:
  // the transactions_standard_authority_check requires customer_id NULL when
  // every standard field is NULL, and the buyers table no longer exists.
  const ephemeralTransactionId = "security-ephemeral-retention";
  await pool.query(
    `INSERT INTO transactions(
       id, service_id, skill_id, status, retention_class,
       expires_at, request_id_hash, canonical_request_hash
     ) VALUES (
       $1,$2,'security-test','completed','ephemeral',
       now() - interval '1 hour', decode(repeat('ab', 32), 'hex'),
       decode(repeat('cd', 32), 'hex')
     )`,
    [ephemeralTransactionId, service.rows[0].id],
  );
  await emitEvent({
    transactionId: ephemeralTransactionId,
    source: "system",
    type: "security.integration.ephemeral-retention",
    message: "Expired anonymous task retention sentinel",
  });
  const ephemeralRetention = await runRetention();
  assert(ephemeralRetention.ephemeralTransactions === 1,
    "expired anonymous task was not counted by retention");
  assert((await pool.query(
    "SELECT 1 FROM transactions WHERE id = $1",
    [ephemeralTransactionId],
  )).rowCount === 0, "expired anonymous task was retained");

  const transactionId = "security-legal-hold-transaction";
  await pool.query(
    `INSERT INTO transactions(id, service_id, skill_id, status)
     VALUES ($1,$2,'security-test','completed') ON CONFLICT (id) DO NOTHING`,
    [transactionId, service.rows[0].id],
  );
  const placed = await placeLegalHold({
    scopeType: "transaction",
    scopeId: transactionId,
    reason: "Preserve release evidence for the security integration test",
    actor: wallet,
  });
  await emitEvent({
    transactionId,
    source: "system",
    type: "security.integration.retention",
    message: "Legal-hold retention sentinel",
  });
  const heldEvent = await pool.query(
    "UPDATE events SET created_at = now() - interval '4000 days' WHERE transaction_id = $1 RETURNING id",
    [transactionId],
  );
  await runRetention();
  assert((await pool.query("SELECT 1 FROM events WHERE id = $1", [heldEvent.rows[0].id])).rowCount === 1,
    "transaction legal hold did not protect a future event");
  await releaseLegalHold(placed.hold.id, wallet);
  await runRetention();
  assert((await pool.query("SELECT 1 FROM events WHERE id = $1", [heldEvent.rows[0].id])).rowCount === 0,
    "released legal hold continued to block retention");
  let rejectedInvalidScope = false;
  try {
    await placeLegalHold({ scopeType: "asset", scopeId: "not-a-uuid", reason: "invalid target test", actor: wallet });
  } catch {
    rejectedInvalidScope = true;
  }
  assert(rejectedInvalidScope, "invalid asset legal-hold scope was accepted");

  await pool.query("CREATE TABLE rotation_unknown_sink(id UUID PRIMARY KEY, secret TEXT NOT NULL)");
  const unknownId = "11111111-1111-4111-8111-111111111111";
  await pool.query(
    "INSERT INTO rotation_unknown_sink(id, secret) VALUES ($1,$2)",
    [unknownId, encryptString("rotation sentinel", {
      purpose: "unknown-test", table: "rotation_unknown_sink", recordId: unknownId, field: "secret",
    })],
  );
  const scan = await scanProtectedData();
  assert(scan.unknownEnvelopeColumns.includes("rotation_unknown_sink.secret"),
    "protected-data scanner missed an unregistered sink");
  await pool.query("DROP TABLE rotation_unknown_sink");

  process.stdout.write("PostgreSQL security integration passed\n");
} finally {
  await closeMigrationPool();
  await pool.end();
}

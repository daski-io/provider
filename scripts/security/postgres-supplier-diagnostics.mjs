import { randomUUID } from "node:crypto";

const { pool } = await import("../../dist/core/db/pool.js");
const {
  runSupplierOperation,
  SupplierOutcomeAmbiguousError,
} = await import("../../dist/core/suppliers/operationJournal.js");
const { SupplierClientError } = await import(
  "../../dist/core/suppliers/errorClassifier.js"
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function verifySupplierOperationDiagnostics() {
  const service = await pool.query(
    "SELECT id FROM services WHERE slug = 'dummy'",
  );
  const serviceId = service.rows[0]?.id;
  assert(serviceId, "dummy service is unavailable for supplier diagnostic test");
  const opKey = `security-diagnostic:${randomUUID()}`;
  const request = { testId: randomUUID() };
  const executeSentinel = "SUPPLIER_EXECUTE_ARBITRARY_SENTINEL";
  let executeError;
  try {
    await runSupplierOperation({
      serviceId,
      opKey,
      kind: "security.diagnostic",
      request,
      execute: async () => {
        throw new SupplierClientError(executeSentinel, {
          supplier: "security-test",
          category: "transport",
        });
      },
      reconcile: async () => null,
    });
  } catch (error) {
    executeError = error;
  }
  assert(
    executeError instanceof SupplierOutcomeAmbiguousError
      && !executeError.message.includes(executeSentinel),
    "supplier execute error escaped its safe diagnostic boundary",
  );
  let stored = await pool.query(
    `SELECT state, error_code, result
       FROM supplier_operations
      WHERE service_id = $1 AND op_key = $2`,
    [serviceId, opKey],
  );
  assert(
    stored.rows[0]?.state === "ambiguous"
      && stored.rows[0]?.error_code === "execute.transport"
      && !JSON.stringify(stored.rows[0]).includes(executeSentinel),
    "supplier execute diagnostic persisted free-form error text",
  );

  const reconcileSentinel = "SUPPLIER_RECONCILE_ARBITRARY_SENTINEL";
  let reconcileError;
  try {
    await runSupplierOperation({
      serviceId,
      opKey,
      kind: "security.diagnostic",
      request,
      execute: async () => ({ outcome: "unexpected-execution" }),
      reconcile: async () => {
        throw new SupplierClientError(reconcileSentinel, {
          supplier: "security-test",
          category: "server",
        });
      },
    });
  } catch (error) {
    reconcileError = error;
  }
  assert(
    reconcileError instanceof SupplierOutcomeAmbiguousError
      && !reconcileError.message.includes(reconcileSentinel),
    "supplier reconcile error escaped its safe diagnostic boundary",
  );
  stored = await pool.query(
    `SELECT state, error_code, result
       FROM supplier_operations
      WHERE service_id = $1 AND op_key = $2`,
    [serviceId, opKey],
  );
  assert(
    stored.rows[0]?.state === "ambiguous"
      && stored.rows[0]?.error_code === "reconcile.server"
      && !JSON.stringify(stored.rows[0]).includes(reconcileSentinel),
    "supplier reconcile diagnostic persisted free-form error text",
  );
}

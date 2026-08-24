import type { Queryable } from "../db/queryable.js";
import { protectEscalationText } from "../security/escalationProtection.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import {
  clearSupplierBreakerFailures,
  closeSupplierBreakerProbe,
  getSupplierBreakerForUpdate,
  linkSupplierBreakerEscalation,
  withSupplierBreakerLock,
  type SupplierCircuitBreakerRow,
} from "./circuitBreakerStore.js";

export interface SupplierBreakerProbe {
  generation: string;
  token: string;
}

export function matchesSupplierBreakerProbe(
  row: SupplierCircuitBreakerRow | null,
  probe: SupplierBreakerProbe,
): boolean {
  return row?.state === "half_open"
    && row.generation === probe.generation
    && row.probe_token === probe.token;
}

export async function closeSupplierBreakerAfterProbe(args: {
  db: Queryable;
  supplier: string;
  current: SupplierCircuitBreakerRow;
  probe: SupplierBreakerProbe;
  transactionId?: string;
}): Promise<boolean> {
  if (!matchesSupplierBreakerProbe(args.current, args.probe)) return false;
  if (args.current.escalation_id) {
    const response = protectEscalationText(
      args.current.escalation_id,
      "response",
      "Supplier connectivity recovered; the outage hold was resolved automatically.",
    );
    await args.db.query(
      `UPDATE escalations
          SET status = 'resolved', response = $2, resolved_at = now(),
              resolved_by = 'system:supplier-breaker'
        WHERE id = $1 AND source <> 'pre_execute'
          AND status IN ('pending','in_agent_review','awaiting_human')`,
      [args.current.escalation_id, response],
    );
    await args.db.query(
      `UPDATE chat_threads SET status = 'resolved', updated_at = now()
        WHERE escalation_id = $1 AND status <> 'resolved'`,
      [args.current.escalation_id],
    );
  }
  const closed = await closeSupplierBreakerProbe(args.db, {
    supplier: args.supplier,
    ...args.probe,
  });
  if (!closed) throw new Error(`lost half-open probe close for ${args.supplier}`);
  await clearSupplierBreakerFailures(args.db, args.supplier);
  await args.db.query(
    `UPDATE durable_jobs
        SET available_at = now(), updated_at = now()
      WHERE id IN (
        SELECT resolution_job_id FROM escalations
         WHERE source = 'fulfillment_hold'
           AND fulfillment_hold_kind = 'outage'
           AND fulfillment_supplier = $1
           AND status = 'resolution_queued'
           AND resolution_job_id IS NOT NULL
      ) AND status IN ('queued','retry')`,
    [args.supplier],
  );
  await args.db.query(
    `UPDATE escalations SET fulfillment_resume_at = now()
      WHERE source = 'fulfillment_hold'
        AND fulfillment_hold_kind = 'outage'
        AND fulfillment_supplier = $1
        AND status = 'resolution_queued'`,
    [args.supplier],
  );
  await recordMandatoryAudit(args.db, {
    transactionId: args.transactionId,
    source: "system",
    type: "supplier.breaker.closed",
    message: `Supplier circuit breaker closed for ${args.supplier}.`,
    payload: {
      supplier: args.supplier,
      reason: "probe_succeeded",
      generation: args.probe.generation,
      escalationId: args.current.escalation_id,
    },
  });
  return true;
}

export async function ensureSupplierBreakerEscalation(
  supplierValue: string,
  create: (db: Queryable) => Promise<{ id: string }>,
): Promise<{ escalationId: string; created: boolean } | null> {
  const supplier = supplierValue.trim().toLowerCase();
  if (!supplier) throw new Error("supplier is required");
  return withSupplierBreakerLock(supplier, async (db) => {
    const current = await getSupplierBreakerForUpdate(db, supplier);
    if (!current || current.state === "closed") return null;
    if (current.escalation_id) {
      return { escalationId: current.escalation_id, created: false };
    }
    const escalation = await create(db);
    const linked = await linkSupplierBreakerEscalation(db, supplier, escalation.id);
    if (!linked) throw new Error(`failed to link supplier breaker escalation for ${supplier}`);
    return { escalationId: escalation.id, created: true };
  });
}

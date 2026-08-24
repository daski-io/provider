import { config } from "../config.js";
import type { Queryable } from "../db/queryable.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import {
  getSupplierFailureWindow,
  pruneSupplierBreakerFailures,
  type SupplierFailureWindow,
} from "./circuitBreakerStore.js";

const MINIMUM_DISTINCT_TASKS = 3;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function supplierBreakerOptions(args: {
  threshold?: number;
  windowMinutes?: number;
  openDurationMinutes?: number;
  minimumDistinctTasks?: number;
}) {
  const windowMinutes = positiveInteger(
    args.windowMinutes ?? config.SUPPLIER_BREAKER_WINDOW_MINUTES,
    "windowMinutes",
  );
  return {
    threshold: positiveInteger(
      args.threshold ?? config.SUPPLIER_BREAKER_THRESHOLD,
      "threshold",
    ),
    windowMinutes,
    openDurationMinutes: positiveInteger(
      args.openDurationMinutes ?? windowMinutes,
      "openDurationMinutes",
    ),
    minimumTasks: positiveInteger(
      args.minimumDistinctTasks ?? MINIMUM_DISTINCT_TASKS,
      "minimumDistinctTasks",
    ),
  };
}

export function validSupplierBreakerDuration(value: number, name: string): number {
  return positiveInteger(value, name);
}

export async function loadSupplierFailureWindow(
  db: Queryable,
  supplier: string,
  now: Date,
  windowMinutes: number,
): Promise<SupplierFailureWindow> {
  const cutoff = new Date(now.getTime() - windowMinutes * 60_000);
  await pruneSupplierBreakerFailures(db, supplier, cutoff);
  return getSupplierFailureWindow(db, supplier, cutoff);
}

export async function auditSupplierBreakerOpened(
  db: Queryable,
  args: { transactionId: string; failureKind: string },
  supplier: string,
  window: SupplierFailureWindow,
  reason: string,
): Promise<void> {
  await recordMandatoryAudit(db, {
    transactionId: args.transactionId,
    source: "system",
    severity: "warn",
    type: "supplier.breaker.opened",
    message: `Supplier circuit breaker opened for ${supplier}.`,
    payload: { supplier, failureKind: args.failureKind, reason, ...window },
  });
}

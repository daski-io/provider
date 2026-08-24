import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import {
  claimSupplierBreakerProbe,
  getSupplierBreakerForUpdate,
  insertSupplierBreakerFailure,
  openSupplierBreaker,
  reopenSupplierBreakerProbe,
  storeSupplierBreakerCounts,
  withSupplierBreakerLock,
  type SupplierCircuitBreakerRow,
  type SupplierFailureWindow,
} from "./circuitBreakerStore.js";
import {
  closeSupplierBreakerAfterProbe,
  matchesSupplierBreakerProbe,
  type SupplierBreakerProbe,
} from "./circuitBreakerRecovery.js";
import {
  auditSupplierBreakerOpened,
  loadSupplierFailureWindow,
  supplierBreakerOptions,
  validSupplierBreakerDuration,
} from "./circuitBreakerPolicy.js";

export {
  ensureSupplierBreakerEscalation,
  type SupplierBreakerProbe,
} from "./circuitBreakerRecovery.js";

const DEFAULT_PROBE_LEASE_MS = 60_000;

export type SupplierBreakerMode = "closed" | "open" | "half_open";

export interface SupplierBreakerDecision {
  supplier: string;
  mode: SupplierBreakerMode;
  shouldHold: boolean;
  openUntil: Date | null;
  probeExpiresAt: Date | null;
  failureCount: number;
  taskCount: number;
  escalationId: string | null;
  probe: SupplierBreakerProbe | null;
}

export interface SupplierBreakerFailureResult {
  breaker: SupplierCircuitBreakerRow;
  opened: boolean;
  window: SupplierFailureWindow;
  probeAccepted: boolean | null;
}

function normalizedSupplier(value: string): string {
  const supplier = value.trim().toLowerCase();
  if (!supplier) throw new Error("supplier is required");
  return supplier;
}

function decision(
  supplier: string,
  mode: SupplierBreakerMode,
  row: SupplierCircuitBreakerRow | null,
  shouldHold: boolean,
  probe: SupplierBreakerProbe | null = null,
): SupplierBreakerDecision {
  return {
    supplier,
    mode,
    shouldHold,
    openUntil: row?.open_until ?? null,
    probeExpiresAt: row?.probe_expires_at ?? null,
    failureCount: row?.failure_count ?? 0,
    taskCount: row?.task_count ?? 0,
    escalationId: row?.escalation_id ?? null,
    probe,
  };
}

export async function recordSupplierBreakerFailure(args: {
  supplier: string;
  transactionId: string;
  failureKind: string;
  failureKey?: string;
  probe?: SupplierBreakerProbe | null;
  now?: Date;
  threshold?: number;
  windowMinutes?: number;
  openDurationMinutes?: number;
  minimumDistinctTasks?: number;
}): Promise<SupplierBreakerFailureResult> {
  const supplier = normalizedSupplier(args.supplier);
  if (!args.transactionId) throw new Error("transactionId is required");
  if (!args.failureKind) throw new Error("failureKind is required");
  const now = args.now ?? new Date();
  const options = supplierBreakerOptions(args);

  return withSupplierBreakerLock(supplier, async (db) => {
    const current = await getSupplierBreakerForUpdate(db, supplier);
    if (args.probe && !matchesSupplierBreakerProbe(current, args.probe)) {
      if (!current) throw new Error(`stale probe references unknown breaker ${supplier}`);
      return {
        breaker: current,
        opened: false,
        window: { failureCount: current.failure_count, taskCount: current.task_count },
        probeAccepted: false,
      };
    }
    if (!args.probe && current?.state === "half_open") {
      return {
        breaker: current,
        opened: false,
        window: { failureCount: current.failure_count, taskCount: current.task_count },
        probeAccepted: false,
      };
    }

    await insertSupplierBreakerFailure(db, {
      supplier,
      transactionId: args.transactionId,
      failureKind: args.failureKind,
      failureKey: args.failureKey,
      failedAt: now,
    });
    const window = await loadSupplierFailureWindow(db, supplier, now, options.windowMinutes);
    if (args.probe && current) {
      const reopened = await reopenSupplierBreakerProbe(db, {
        supplier,
        generation: args.probe.generation,
        token: args.probe.token,
        openedAt: now,
        openUntil: new Date(now.getTime() + options.openDurationMinutes * 60_000),
        window,
      });
      if (!reopened) throw new Error(`lost half-open probe failure for ${supplier}`);
      await auditSupplierBreakerOpened(db, args, supplier, window, "probe_failed");
      return { breaker: reopened, opened: true, window, probeAccepted: true };
    }

    const thresholdReached = window.failureCount >= options.threshold
      && window.taskCount >= options.minimumTasks;
    if (current?.state === "open" || !thresholdReached) {
      return {
        breaker: await storeSupplierBreakerCounts(db, supplier, window),
        opened: false,
        window,
        probeAccepted: null,
      };
    }
    const breaker = await openSupplierBreaker(db, {
      supplier,
      openedAt: now,
      openUntil: new Date(now.getTime() + options.openDurationMinutes * 60_000),
      window,
    });
    await auditSupplierBreakerOpened(db, args, supplier, window, "threshold_reached");
    return { breaker, opened: true, window, probeAccepted: null };
  });
}

export async function getSupplierBreakerDecision(args: {
  supplier: string;
  now?: Date;
  probeLeaseMs?: number;
  openDurationMinutes?: number;
}): Promise<SupplierBreakerDecision> {
  const supplier = normalizedSupplier(args.supplier);
  const now = args.now ?? new Date();
  const leaseMs = validSupplierBreakerDuration(
    args.probeLeaseMs ?? DEFAULT_PROBE_LEASE_MS,
    "probeLeaseMs",
  );
  const openMinutes = validSupplierBreakerDuration(
    args.openDurationMinutes ?? config.SUPPLIER_BREAKER_WINDOW_MINUTES,
    "openDurationMinutes",
  );
  return withSupplierBreakerLock(supplier, async (db) => {
    const current = await getSupplierBreakerForUpdate(db, supplier);
    if (!current || current.state === "closed") {
      return decision(supplier, "closed", current, false);
    }
    if (current.state === "half_open") {
      if (!current.probe_token || !current.probe_expires_at) {
        throw new Error(`half-open breaker ${supplier} has no persisted probe`);
      }
      if (current.probe_expires_at.getTime() > now.getTime()) {
        return decision(supplier, "half_open", current, true);
      }
      const reopened = await reopenSupplierBreakerProbe(db, {
        supplier,
        generation: current.generation,
        token: current.probe_token,
        openedAt: now,
        openUntil: new Date(now.getTime() + openMinutes * 60_000),
        window: { failureCount: current.failure_count, taskCount: current.task_count },
      });
      if (!reopened) throw new Error(`lost expired half-open probe for ${supplier}`);
      await recordMandatoryAudit(db, {
        source: "system",
        severity: "warn",
        type: "supplier.breaker.opened",
        message: `Supplier circuit breaker reopened for ${supplier}.`,
        payload: { supplier, reason: "probe_lease_expired", generation: current.generation },
      });
      return decision(supplier, "open", reopened, true);
    }
    if (current.open_until === null || current.open_until.getTime() > now.getTime()) {
      return decision(supplier, "open", current, true);
    }
    const token = randomUUID();
    const claimed = await claimSupplierBreakerProbe(db, {
      supplier,
      expectedGeneration: current.generation,
      token,
      now,
      leaseUntil: new Date(now.getTime() + leaseMs),
    });
    if (!claimed) throw new Error(`lost half-open probe claim for ${supplier}`);
    const probe = { generation: claimed.generation, token };
    await recordMandatoryAudit(db, {
      source: "system",
      type: "supplier.breaker.half_open",
      message: `Supplier circuit breaker admitted one probe for ${supplier}.`,
      payload: { supplier, generation: probe.generation, probeLeaseMs: leaseMs },
    });
    return decision(supplier, "half_open", claimed, false, probe);
  });
}

export async function recordSupplierBreakerSuccess(args: {
  supplier: string;
  transactionId?: string;
  probe: SupplierBreakerProbe;
}): Promise<boolean> {
  const supplier = normalizedSupplier(args.supplier);
  return withSupplierBreakerLock(supplier, async (db) => {
    const current = await getSupplierBreakerForUpdate(db, supplier);
    if (!current || !matchesSupplierBreakerProbe(current, args.probe)) return false;
    return closeSupplierBreakerAfterProbe({
      db,
      supplier,
      current,
      probe: args.probe,
      transactionId: args.transactionId,
    });
  });
}

import { beforeEach, describe, expect, it, vi } from "vitest";

type Breaker = {
  supplier: string;
  state: "closed" | "open" | "half_open";
  opened_at: Date | null;
  open_until: Date | null;
  failure_count: number;
  task_count: number;
  escalation_id: string | null;
  generation: string;
  probe_token: string | null;
  probe_expires_at: Date | null;
  updated_at: Date;
};

const h = vi.hoisted(() => ({
  failures: [] as Array<{
    supplier: string;
    transactionId: string;
    key: string | null;
    failedAt: Date;
  }>,
  breakers: new Map<string, Breaker>(),
  audits: [] as string[],
  resolvedEscalations: [] as string[],
  resolvedChats: [] as string[],
  resumedSuppliers: [] as string[],
  query: vi.fn(),
}));

function emptyBreaker(supplier: string): Breaker {
  return {
    supplier,
    state: "closed",
    opened_at: null,
    open_until: null,
    failure_count: 0,
    task_count: 0,
    escalation_id: null,
    generation: "0",
    probe_token: null,
    probe_expires_at: null,
    updated_at: new Date(0),
  };
}

h.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes("pg_advisory_xact_lock")) {
    return { rows: [] };
  }
  if (sql.includes("INSERT INTO supplier_breaker_failures")) {
    const key = params[3] as string | null;
    const duplicate = key && h.failures.some(
      (row) => row.supplier === params[0] && row.key === key,
    );
    if (duplicate) return { rows: [] };
    h.failures.push({
      supplier: params[0] as string,
      transactionId: params[1] as string,
      key,
      failedAt: params[4] as Date,
    });
    return { rows: [{ id: `failure-${h.failures.length}` }] };
  }
  if (sql.includes("DELETE FROM supplier_breaker_failures")) {
    h.failures = h.failures.filter((row) =>
      row.supplier !== params[0] || (params[1] && row.failedAt >= (params[1] as Date)));
    return { rows: [] };
  }
  if (sql.includes("COUNT(DISTINCT transaction_id)")) {
    const rows = h.failures.filter(
      (row) => row.supplier === params[0] && row.failedAt >= (params[1] as Date),
    );
    return { rows: [{
      failure_count: rows.length,
      task_count: new Set(rows.map((row) => row.transactionId)).size,
    }] };
  }
  if (sql.includes("SELECT * FROM supplier_circuit_breakers")) {
    const row = h.breakers.get(params[0] as string);
    return { rows: row ? [row] : [] };
  }
  if (sql.includes("INSERT INTO supplier_circuit_breakers")) {
    const supplier = params[0] as string;
    const row = h.breakers.get(supplier) ?? emptyBreaker(supplier);
    if (sql.includes("VALUES ($1, 'open'")) {
      Object.assign(row, {
        state: "open",
        opened_at: params[1],
        open_until: params[2],
        failure_count: params[3],
        task_count: params[4],
        escalation_id: null,
        generation: String(Number(row.generation) + 1),
        probe_token: null,
        probe_expires_at: null,
      });
    } else {
      Object.assign(row, { failure_count: params[1], task_count: params[2] });
    }
    h.breakers.set(supplier, row);
    return { rows: [row] };
  }
  if (sql.includes("SET state = 'half_open'")) {
    const row = h.breakers.get(params[0] as string);
    if (!row || row.state !== "open" || row.generation !== params[1]
      || !row.open_until || row.open_until > (params[3] as Date)) return { rows: [] };
    Object.assign(row, {
      state: "half_open",
      generation: String(Number(row.generation) + 1),
      probe_token: params[2],
      probe_expires_at: params[4],
    });
    return { rows: [row] };
  }
  if (sql.includes("SET state = 'open'")) {
    const row = h.breakers.get(params[0] as string);
    if (!row || row.state !== "half_open" || row.generation !== params[1]
      || row.probe_token !== params[2]) return { rows: [] };
    Object.assign(row, {
      state: "open",
      opened_at: params[3],
      open_until: params[4],
      failure_count: params[5],
      task_count: params[6],
      probe_token: null,
      probe_expires_at: null,
    });
    return { rows: [row] };
  }
  if (sql.includes("SET escalation_id = $2")) {
    const row = h.breakers.get(params[0] as string);
    if (!row || row.state === "closed" || row.escalation_id) return { rows: [] };
    row.escalation_id = params[1] as string;
    return { rows: [{ escalation_id: row.escalation_id }] };
  }
  if (sql.includes("UPDATE durable_jobs")) {
    h.resumedSuppliers.push(params[0] as string);
    return { rows: [] };
  }
  if (sql.includes("SET fulfillment_resume_at = now()")) {
    return { rows: [] };
  }
  if (sql.includes("UPDATE escalations")) {
    h.resolvedEscalations.push(params[0] as string);
    return { rows: [] };
  }
  if (sql.includes("UPDATE chat_threads")) {
    h.resolvedChats.push(params[0] as string);
    return { rows: [] };
  }
  if (sql.includes("SET state = 'closed'")) {
    const row = h.breakers.get(params[0] as string);
    if (!row || row.state !== "half_open" || row.generation !== params[1]
      || row.probe_token !== params[2]) return { rows: [] };
    Object.assign(row, emptyBreaker(row.supplier), { generation: row.generation });
    h.breakers.set(row.supplier, row);
    return { rows: [row] };
  }
  throw new Error(`unexpected SQL: ${sql}`);
});

vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: h.query,
    connect: vi.fn(async () => ({ query: h.query, release: vi.fn() })),
  },
}));
vi.mock("../src/core/config.js", () => ({
  config: { SUPPLIER_BREAKER_THRESHOLD: 5, SUPPLIER_BREAKER_WINDOW_MINUTES: 30 },
}));
vi.mock("../src/core/events/emitter.js", () => ({
  recordMandatoryAudit: vi.fn(async (_db, event) => h.audits.push(event.type)),
}));
vi.mock("../src/core/security/escalationProtection.js", () => ({
  protectEscalationText: vi.fn((_id, _field, value) => `protected:${value}`),
}));

import {
  ensureSupplierBreakerEscalation,
  getSupplierBreakerDecision,
  recordSupplierBreakerFailure,
  recordSupplierBreakerSuccess,
} from "../src/core/suppliers/circuitBreaker.js";

const start = new Date("2026-07-13T12:00:00.000Z");

async function fail(task: string, offsetMs = 0, failureKey?: string) {
  return recordSupplierBreakerFailure({
    supplier: "sample-supplier",
    transactionId: task,
    failureKind: "transient",
    failureKey,
    now: new Date(start.getTime() + offsetMs),
  });
}

async function openBreaker() {
  for (let i = 0; i < 5; i += 1) await fail(`task-${i % 3}`, i, `failure-${i}`);
}

describe("supplier circuit breaker", () => {
  beforeEach(() => {
    h.failures = [];
    h.breakers.clear();
    h.audits = [];
    h.resolvedEscalations = [];
    h.resolvedChats = [];
    h.resumedSuppliers = [];
    h.query.mockClear();
  });

  it("opens once at threshold and deduplicates durable failure keys", async () => {
    await fail("task-1", 0, "attempt-1");
    await fail("task-1", 1, "attempt-1");
    await fail("task-1", 2, "attempt-2");
    await fail("task-2", 3, "attempt-3");
    await fail("task-2", 4, "attempt-4");
    const opened = await fail("task-3", 5, "attempt-5");
    expect(opened.window).toEqual({ failureCount: 5, taskCount: 3 });
    expect(opened.breaker.state).toBe("open");
    expect(h.audits.filter((type) => type === "supplier.breaker.opened")).toHaveLength(1);
  });

  it("does not open across fewer than three tasks", async () => {
    for (let i = 0; i < 6; i += 1) await fail(`task-${i % 2}`, i, `failure-${i}`);
    expect(h.breakers.get("sample-supplier")?.state).toBe("closed");
  });

  it("admits one fenced probe and matching success closes it", async () => {
    await openBreaker();
    const now = new Date(start.getTime() + 31 * 60_000);
    const admitted = await getSupplierBreakerDecision({ supplier: "sample-supplier", now });
    const held = await getSupplierBreakerDecision({ supplier: "sample-supplier", now });
    expect(admitted).toMatchObject({ mode: "half_open", shouldHold: false });
    expect(admitted.probe).not.toBeNull();
    expect(held).toMatchObject({ mode: "half_open", shouldHold: true, probe: null });
    expect(await recordSupplierBreakerSuccess({
      supplier: "sample-supplier",
      probe: admitted.probe!,
    })).toBe(true);
    expect(h.resumedSuppliers).toEqual(["sample-supplier"]);
    expect((await getSupplierBreakerDecision({ supplier: "sample-supplier" })).mode).toBe("closed");
  });

  it("failed probes reopen for a full window and stale success cannot close", async () => {
    await openBreaker();
    const now = new Date(start.getTime() + 31 * 60_000);
    const admitted = await getSupplierBreakerDecision({ supplier: "sample-supplier", now });
    const failure = await recordSupplierBreakerFailure({
      supplier: "sample-supplier",
      transactionId: "probe-task",
      failureKind: "transient",
      failureKey: "probe-failure",
      probe: admitted.probe,
      now,
    });
    expect(failure).toMatchObject({ opened: true, probeAccepted: true });
    expect(failure.breaker.open_until).toEqual(new Date(now.getTime() + 30 * 60_000));
    expect(await recordSupplierBreakerSuccess({
      supplier: "sample-supplier",
      probe: admitted.probe!,
    })).toBe(false);
    expect(h.breakers.get("sample-supplier")?.state).toBe("open");
  });

  it("expired probe leases reopen before another generation is admitted", async () => {
    await openBreaker();
    const first = new Date(start.getTime() + 31 * 60_000);
    const admitted = await getSupplierBreakerDecision({
      supplier: "sample-supplier",
      now: first,
      probeLeaseMs: 1_000,
    });
    const expired = await getSupplierBreakerDecision({
      supplier: "sample-supplier",
      now: new Date(first.getTime() + 1_001),
    });
    expect(expired).toMatchObject({ mode: "open", shouldHold: true, probe: null });
    const replacement = await getSupplierBreakerDecision({
      supplier: "sample-supplier",
      now: new Date(first.getTime() + 31 * 60_000),
    });
    expect(replacement.probe?.generation).not.toBe(admitted.probe?.generation);
    expect(await recordSupplierBreakerSuccess({
      supplier: "sample-supplier",
      probe: admitted.probe!,
    })).toBe(false);
    expect(h.breakers.get("sample-supplier")?.state).toBe("half_open");
    expect(await recordSupplierBreakerSuccess({
      supplier: "sample-supplier",
      probe: replacement.probe!,
    })).toBe(true);
  });

  it("resolves the one linked escalation only after the admitted success", async () => {
    await openBreaker();
    const create = vi.fn(async () => ({ id: "escalation-1" }));
    await ensureSupplierBreakerEscalation("sample-supplier", create);
    const admitted = await getSupplierBreakerDecision({
      supplier: "sample-supplier",
      now: new Date(start.getTime() + 31 * 60_000),
    });
    await recordSupplierBreakerSuccess({ supplier: "sample-supplier", probe: admitted.probe! });
    expect(create).toHaveBeenCalledOnce();
    expect(h.resolvedEscalations).toEqual(["escalation-1"]);
    expect(h.resolvedChats).toEqual(["escalation-1"]);
  });
});

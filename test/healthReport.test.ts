import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkDatabase: vi.fn(),
  query: vi.fn(),
  getAllServices: vi.fn(),
  state: { epoch: 1, legacy: 0, asyncAdmission: false },
}));

vi.mock("../src/core/db/pool.js", () => ({
  checkDatabase: mocks.checkDatabase,
  pool: { query: mocks.query },
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAllServices: mocks.getAllServices,
}));

import {
  healthReport,
  healthRouter,
  resetHealthCachesForTests,
  setExternalJobSalesSource,
  setProviderIdentityStatus,
  setRailStatus,
  setServicingHealthSource,
} from "../src/core/health.js";
import { clearSalesStopsForTests, stopNewSales } from "../src/core/standardRail/salesStops.js";

const syncService = (ready = true, skills: Array<Record<string, unknown>> = [{}]) => ({
  adapter: {}, skills, readiness: async () => ready,
});
const jobService = () => ({ adapter: { mode: "external-job" }, skills: [{}], readiness: async () => true });

// The provider's own state as the three health reads see it.
function answer(sql: string) {
  if (sql.includes("to_regclass('provider_schema_epoch')")) return { rows: [{ present: true }] };
  if (sql.includes("FROM provider_schema_epoch")) return { rows: [{ epoch: mocks.state.epoch }] };
  if (sql.includes("FROM provider_transactions")) return { rows: [{ count: mocks.state.legacy }] };
  if (sql.includes("FROM provider_async_admission")) {
    return { rows: [{ enabled: mocks.state.asyncAdmission, changed_at: null }] };
  }
  throw new Error(`unexpected health query: ${sql}`);
}

async function getHealth(path = "ready"): Promise<{ status: number; body: Record<string, any>; ms: number }> {
  const server = express().use("/health", healthRouter).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health/${path}`);
    return { status: response.status, body: await response.json() as Record<string, any>, ms: Date.now() - started };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const getReady = () => getHealth("ready");

// C05: routing follows read serviceability; new-sale readiness and the
// worker's servicing health are reported beside it and never take funded
// orders' reads off the network.
describe("/health/ready separates reads, admission and servicing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHealthCachesForTests();
    clearSalesStopsForTests();
    mocks.state = { epoch: 1, legacy: 0, asyncAdmission: false };
    mocks.checkDatabase.mockResolvedValue(true);
    mocks.query.mockImplementation(async (sql: string) => answer(sql));
    mocks.getAllServices.mockReturnValue([syncService()]);
    setProviderIdentityStatus(true);
    setRailStatus(true);
    setServicingHealthSource(() => ({ status: "ok", codes: [] }));
    setExternalJobSalesSource(() => ({ activeKey: true, workerRunning: true }));
  });

  it("is ready and open when everything is", async () => {
    const { status, body } = await getReady();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "ready",
      reads: { status: "ok", codes: [] },
      admission: { status: "open", codes: [] },
      servicing: { status: "ok", codes: [] },
    });
  });

  it("keeps reads routable while a product or chain outage stops new sales", async () => {
    mocks.getAllServices.mockReturnValue([syncService(false)]);
    let answered = await getReady();
    expect(answered.status).toBe(200);
    expect(answered.body.admission).toEqual({ status: "stopped", codes: ["service_unready"] });

    resetHealthCachesForTests();
    mocks.getAllServices.mockReturnValue([syncService()]);
    setRailStatus(false);
    answered = await getReady();
    expect(answered.status).toBe(200);
    expect(answered.body.reads.status).toBe("ok");
    expect(answered.body.admission).toEqual({ status: "stopped", codes: ["rail_unverified"] });
  });

  it("stops routing when the database cannot be read or its epoch is not this build's", async () => {
    mocks.checkDatabase.mockResolvedValue(false);
    let answered = await getReady();
    expect(answered.status).toBe(503);
    expect(answered.body).toMatchObject({
      status: "not_ready",
      reads: { status: "unavailable", codes: ["database_unavailable"] },
      admission: { status: "stopped", codes: ["database_unavailable"] },
    });

    resetHealthCachesForTests();
    mocks.checkDatabase.mockResolvedValue(true);
    mocks.state.epoch = 2;
    answered = await getReady();
    expect(answered.status).toBe(503);
    expect(answered.body.reads).toEqual({ status: "unavailable", codes: ["schema_epoch_unsupported"] });
    expect(answered.body.admission.codes).toContain("schema_epoch_unsupported");
  });

  it("limits sales for drifted listings and external-job prerequisites", async () => {
    stopNewSales(`0x${"ab".repeat(32)}`, "contract_drift");
    mocks.getAllServices.mockReturnValue([syncService(), jobService()]);
    setExternalJobSalesSource(() => ({ activeKey: false, workerRunning: false }));
    let report = await healthReport();
    expect(report.reads.status).toBe("ok");
    expect(report.admission).toEqual({
      status: "limited",
      codes: ["contract_drift", "async_admission_off", "encryption_key_missing", "external_job_worker_stopped"],
    });

    // With only external-job services, the same stops leave nothing to sell.
    resetHealthCachesForTests();
    clearSalesStopsForTests();
    mocks.getAllServices.mockReturnValue([jobService()]);
    setExternalJobSalesSource(() => ({ activeKey: true, workerRunning: true }));
    report = await healthReport();
    expect(report.admission).toEqual({ status: "stopped", codes: ["async_admission_off"] });

    resetHealthCachesForTests();
    mocks.state.asyncAdmission = true;
    report = await healthReport();
    expect(report.admission).toEqual({ status: "open", codes: [] });
  });

  it("reports the worker's codes and pending pre-R1 executions as servicing health only", async () => {
    mocks.state.legacy = 2;
    setServicingHealthSource(() => ({ status: "degraded", codes: ["external_job_overdue"] }));
    const { status, body } = await getReady();
    expect(status).toBe(200);
    expect(body.admission.status).toBe("open");
    expect(body.servicing).toEqual({
      status: "degraded",
      codes: ["external_job_overdue", "legacy_executions_pending"],
    });
  });

  it("answers routing quickly while a product readiness probe hangs", async () => {
    mocks.getAllServices.mockReturnValue([{ adapter: {}, skills: [{}], readiness: () => new Promise(() => undefined) }]);
    const { status, body, ms } = await getReady();
    expect(status).toBe(200);
    expect(ms).toBeLessThan(2_000);
    expect(body.reads.status).toBe("ok");
    expect(body.admission).toEqual({ status: "stopped", codes: ["readiness_pending"] });
  });

  it("reports the probe's result once it completes, never a stale generation's", async () => {
    vi.useFakeTimers();
    try {
      mocks.getAllServices.mockReturnValue([{ adapter: {}, skills: [{}], readiness: () => new Promise(() => undefined) }]);
      const first = healthReport();
      await vi.advanceTimersByTimeAsync(300);
      expect((await first).admission.codes).toEqual(["readiness_pending"]);
      // The bounded product probe gives up after three seconds: not ready.
      await vi.advanceTimersByTimeAsync(3_000);
      expect((await healthReport()).admission).toEqual({ status: "stopped", codes: ["service_unready"] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps routing on the last known epoch through a transient read error, and opens /health/admission only when open", async () => {
    expect((await getHealth("admission")).status).toBe(200);
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM provider_schema_epoch")) throw new Error("statement timeout");
      return answer(sql);
    });
    const later = await healthReport(Date.now() + 60_000);
    expect(later.reads).toEqual({ status: "ok", codes: [] });

    resetHealthCachesForTests();
    mocks.getAllServices.mockReturnValue([syncService(true, [{ acceptingNewOrders: false }, {}])]);
    mocks.query.mockImplementation(async (sql: string) => answer(sql));
    const paused = await getHealth("admission");
    expect(paused.status).toBe(503);
    expect(paused.body.admission).toEqual({ status: "limited", codes: ["sales_paused"] });
    // Never read successfully: the database cannot be judged.
    resetHealthCachesForTests();
    mocks.query.mockRejectedValue(new Error("statement timeout"));
    expect((await healthReport()).reads).toEqual({ status: "unavailable", codes: ["database_unavailable"] });
  });

  it("issues only reads of the provider's own state", async () => {
    await healthReport();
    for (const [sql] of mocks.query.mock.calls as Array<[string]>) {
      expect(sql.trimStart()).toMatch(/^SELECT\b/);
    }
  });
});

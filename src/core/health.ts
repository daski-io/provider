import { Router } from "express";
import { config } from "./config.js";
import { checkDatabase, pool } from "./db/pool.js";
import { readDatabaseSchemaEpoch, RUNTIME_SCHEMA_EPOCH } from "./db/runtimeEpoch.js";
import { getAllServices } from "./serviceRegistry/registry.js";
import type { ServiceModule } from "./serviceRegistry/types.js";
import { readAsyncAdmission } from "./standardRail/asyncAdmission.js";
import { countLegacyExecutions } from "./standardRail/legacyCutover.js";
import { activeSalesStopReasons } from "./standardRail/salesStops.js";

interface DependencyStatus {
  ready: boolean;
  checkedAt: number;
}

const SERVICE_READINESS_TIMEOUT_MS = 3_000;

/** Servicing health (the external-job worker and its jobs), reported apart from routing readiness. */
export interface ServicingHealth {
  status: "ok" | "degraded";
  codes: string[];
}

/** Why persisted status and artifact reads cannot be served: routing stops (503). */
export type ReadCode = "database_unavailable" | "schema_epoch_unsupported";

/** Why some or all new sales stop; funded orders and reads continue. */
export type AdmissionCode =
  | ReadCode
  | "identity_unverified"
  | "rail_unverified"
  | "no_services"
  | "service_unready"
  | "contract_drift"
  | "async_admission_off"
  | "encryption_key_missing"
  | "external_job_worker_stopped";

/** What this process's external-job runtime can do for new external-job sales. */
export interface ExternalJobSalesPosture {
  activeKey: boolean;
  workerRunning: boolean;
}

/**
 * `/health/ready`, in three parts (C05): read serviceability decides the
 * status code, so a process that can still answer funded orders' status
 * and artifact reads stays routable; admission says whether new sales are
 * taken; servicing is the external-job worker's view of owed work.
 */
export interface HealthReport {
  reads: { status: "ok" | "unavailable"; codes: ReadCode[] };
  admission: { status: "open" | "limited" | "stopped"; codes: AdmissionCode[] };
  servicing: ServicingHealth;
}

let servicingHealth: () => ServicingHealth = () => ({ status: "ok", codes: [] });
let externalJobSales: () => ExternalJobSalesPosture = () => ({ activeKey: false, workerRunning: false });

/** The process registers its worker's health; `/health/ready` reports it. */
export function setServicingHealthSource(source: () => ServicingHealth): void {
  servicingHealth = source;
}

/** The process registers what its external-job runtime can sell; admission reports it. */
export function setExternalJobSalesSource(source: () => ExternalJobSalesPosture): void {
  externalJobSales = source;
}

let identity: DependencyStatus = { ready: false, checkedAt: 0 };
let rail: DependencyStatus = { ready: false, checkedAt: 0 };

interface SalesReadiness {
  ready: boolean;
  /** Null when not probed: identity, rail or services were already not ready. */
  database: boolean | null;
  servicesReady: boolean | null;
}

let cached: { expiresAt: number; result: SalesReadiness } | null = null;

export function setProviderIdentityStatus(ready: boolean): void {
  identity = { ready, checkedAt: Date.now() };
  cached = null;
}

export function setRailStatus(ready: boolean): void {
  rail = { ready, checkedAt: Date.now() };
  cached = null;
}

export function readinessSnapshot(now = Date.now()): {
  identity: boolean;
  rail: boolean;
  services: boolean;
} {
  const maximumAge = config.READINESS_MAX_AGE_SECONDS * 1_000;
  return {
    identity: identity.ready && identity.checkedAt >= now - maximumAge,
    rail: rail.ready && rail.checkedAt >= now - maximumAge,
    services: getAllServices().length > 0,
  };
}

/** One service's bounded, read-only readiness (three seconds); a throw or timeout is not ready. */
export async function serviceIsReady(service: ServiceModule): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVICE_READINESS_TIMEOUT_MS);
  timeout.unref();
  try {
    return await Promise.race([
      service.readiness(controller.signal),
      new Promise<boolean>((resolve) => controller.signal.addEventListener(
        "abort",
        () => resolve(false),
        { once: true },
      )),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function salesReadiness(): Promise<SalesReadiness> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.result;
  const snapshot = readinessSnapshot(now);
  let result: SalesReadiness = { ready: false, database: null, servicesReady: null };
  if (snapshot.identity && snapshot.rail && snapshot.services) {
    const services = getAllServices();
    const [database, ...serviceStatuses] = await Promise.all([
      checkDatabase(),
      ...services.map(serviceIsReady),
    ]);
    const servicesReady = serviceStatuses.every(Boolean);
    result = { ready: database && servicesReady, database, servicesReady };
  }
  cached = { result, expiresAt: now + config.HEALTH_READINESS_CACHE_MS };
  return result;
}

/** Complete provider readiness for new sales (quotes, the outcome list, new synchronous dispatches). */
export async function providerReady(): Promise<boolean> {
  return (await salesReadiness()).ready;
}

interface DatabaseFacts {
  reachable: boolean;
  /** Null when unreadable, which no supported schema allows. */
  epoch: number | null;
  /** Null when unreadable; then no servicing code is raised for it. */
  legacyExecutions: number | null;
  /** An unreadable switch reads as off. */
  asyncAdmission: boolean;
}

let factsCache: { expiresAt: number; facts: DatabaseFacts } | null = null;

/**
 * Small reads of the provider's own state (SELECT only): reachability, the
 * schema epoch, interrupted pre-R1 executions awaiting the cutover, and the
 * async-admission switch.
 */
async function databaseFacts(now: number): Promise<DatabaseFacts> {
  if (factsCache && factsCache.expiresAt > now) return factsCache.facts;
  let facts: DatabaseFacts = { reachable: false, epoch: null, legacyExecutions: null, asyncAdmission: false };
  if (await checkDatabase()) {
    const [epoch, legacyExecutions, asyncAdmission] = await Promise.all([
      readDatabaseSchemaEpoch(pool).catch(() => null),
      countLegacyExecutions(pool).catch(() => null),
      readAsyncAdmission(pool).then((state) => state.enabled, () => false),
    ]);
    facts = { reachable: true, epoch, legacyExecutions, asyncAdmission };
  }
  factsCache = { facts, expiresAt: now + config.HEALTH_READINESS_CACHE_MS };
  return facts;
}

const isExternalJobService = (service: ServiceModule) => service.adapter.mode === "external-job";

/** The health report `/health/ready` answers; cached reads, no product or upstream call. */
export async function healthReport(now = Date.now()): Promise<HealthReport> {
  const [sales, facts] = await Promise.all([salesReadiness(), databaseFacts(now)]);
  const reads: ReadCode[] = !facts.reachable
    ? ["database_unavailable"]
    : facts.epoch === RUNTIME_SCHEMA_EPOCH ? [] : ["schema_epoch_unsupported"];
  const snapshot = readinessSnapshot(now);
  const admission: AdmissionCode[] = [...reads];
  if (sales.database === false && !admission.includes("database_unavailable")) {
    admission.push("database_unavailable");
  }
  if (!snapshot.identity) admission.push("identity_unverified");
  if (!snapshot.rail) admission.push("rail_unverified");
  if (!snapshot.services) admission.push("no_services");
  if (sales.servicesReady === false) admission.push("service_unready");
  const allStopped = !sales.ready || reads.length > 0;
  const limits: AdmissionCode[] = activeSalesStopReasons();
  const services = getAllServices();
  const jobServices = services.filter(isExternalJobService);
  if (jobServices.length > 0) {
    const posture = externalJobSales();
    if (facts.reachable && !facts.asyncAdmission) limits.push("async_admission_off");
    if (!posture.activeKey) limits.push("encryption_key_missing");
    if (!posture.workerRunning) limits.push("external_job_worker_stopped");
  }
  admission.push(...limits);
  // Every installed service sells external jobs and their sales stopped:
  // nothing can be sold, as when complete readiness fails.
  const jobSalesStopped = limits.some((code) => code !== "contract_drift");
  const stopped = allStopped || (jobSalesStopped && jobServices.length === services.length);
  const worker = servicingHealth();
  const servicingCodes = [...worker.codes];
  if ((facts.legacyExecutions ?? 0) > 0) servicingCodes.push("legacy_executions_pending");
  return {
    reads: { status: reads.length === 0 ? "ok" : "unavailable", codes: reads },
    admission: {
      status: stopped ? "stopped" : admission.length > 0 ? "limited" : "open",
      codes: admission,
    },
    servicing: { status: servicingCodes.length === 0 ? "ok" : "degraded", codes: servicingCodes },
  };
}

/** Tests: forget cached readiness and database facts. */
export function resetHealthCachesForTests(): void {
  cached = null;
  factsCache = null;
}

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({
    status: "alive",
    timestamp: new Date().toISOString(),
    revision: config.DEPLOYMENT_REVISION ?? "unknown",
  });
});

healthRouter.get("/live", (_req, res) => {
  res.json({ status: "alive", timestamp: new Date().toISOString() });
});

// The status code is routing readiness: whether this process can serve
// funded orders' persisted status and artifact reads (C05). New-sale
// readiness and servicing health are reported beside it and never change
// it: a product or chain outage stops new quotes in-process, a stopped
// external-job worker stops new external-job sales, and neither may take
// reads off the network; a slow upstream job is never a reason to restart.
healthRouter.get("/ready", async (_req, res) => {
  const report = await healthReport();
  const ready = report.reads.status === "ok";
  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    checkedAt: new Date().toISOString(),
    ...report,
  });
});

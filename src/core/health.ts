import { Router } from "express";
import { config } from "./config.js";
import { checkDatabase, pool } from "./db/pool.js";
import { readDatabaseSchemaEpoch, RUNTIME_SCHEMA_EPOCH } from "./db/runtimeEpoch.js";
import { readinessSnapshot, resetSalesReadinessForTests, salesReadinessWithin } from "./salesReadiness.js";
import { getAllServices } from "./serviceRegistry/registry.js";
import type { ServiceModule } from "./serviceRegistry/types.js";
import { readAsyncAdmission } from "./standardRail/asyncAdmission.js";
import { countLegacyExecutions } from "./standardRail/legacyCutover.js";
import { activeSalesStopReasons } from "./standardRail/salesStops.js";

export {
  providerReady,
  readinessSnapshot,
  serviceIsReady,
  setProviderIdentityStatus,
  setRailStatus,
} from "./salesReadiness.js";

/**
 * How long `/health/ready` waits for a running sales-readiness probe (which
 * may wait up to three seconds on a product) before it reports the last
 * completed one: the routing answer never waits on a product.
 */
const ROUTE_READINESS_BUDGET_MS = 250;

/** Servicing health (the external-job worker and its jobs), reported apart from routing readiness. */
export interface ServicingHealth {
  status: "ok" | "degraded";
  codes: string[];
}

/** Why persisted status and artifact reads cannot be served: routing stops (503). */
export type ReadCode = "database_unavailable" | "schema_epoch_unsupported";

/**
 * Why some or all new quotes stop, process-wide or for paused skills and
 * drifted listings; per-listing capacity and an invalid result mapping show
 * in the quote's own reason. Admitted orders and reads continue, but
 * `async_admission_off` and `encryption_key_missing` also refuse funded
 * external-job dispatches that are not admitted yet (retryably).
 */
export type AdmissionCode =
  | ReadCode
  | "identity_unverified"
  | "rail_unverified"
  | "no_services"
  | "readiness_pending"
  | "service_unready"
  | "sales_paused"
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

interface DatabaseFacts {
  reachable: boolean;
  /** The last epoch read; only migrations change it, so a failed read keeps it. */
  epoch: number | null;
  /** Null when unreadable; then no servicing code is raised for it. */
  legacyExecutions: number | null;
  /** An unreadable switch reads as off. */
  asyncAdmission: boolean;
}

let factsCache: { expiresAt: number; facts: DatabaseFacts } | null = null;
let lastEpoch: number | null = null;

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
      readDatabaseSchemaEpoch(pool).then((value) => (lastEpoch = value), () => lastEpoch),
      countLegacyExecutions(pool).catch(() => null),
      readAsyncAdmission(pool).then((state) => state.enabled, () => false),
    ]);
    // Never read successfully: the database cannot be judged, so not routable.
    facts = { reachable: epoch !== null, epoch, legacyExecutions, asyncAdmission };
  }
  factsCache = { facts, expiresAt: now + config.HEALTH_READINESS_CACHE_MS };
  return facts;
}

const isExternalJobService = (service: ServiceModule) => service.adapter.mode === "external-job";

/**
 * The health report `/health/ready` answers: cached reads of in-process
 * state and a few SELECTs. It never waits on a product: a sales-readiness
 * probe still running after a short budget is reported from its last result.
 */
export async function healthReport(now = Date.now()): Promise<HealthReport> {
  const [sales, facts] = await Promise.all([
    salesReadinessWithin(ROUTE_READINESS_BUDGET_MS),
    databaseFacts(now),
  ]);
  const reads: ReadCode[] = !facts.reachable
    ? ["database_unavailable"]
    : facts.epoch === RUNTIME_SCHEMA_EPOCH ? [] : ["schema_epoch_unsupported"];
  const snapshot = readinessSnapshot(now);
  const admission: AdmissionCode[] = [...reads];
  if (!snapshot.identity) admission.push("identity_unverified");
  if (!snapshot.rail) admission.push("rail_unverified");
  if (!snapshot.services) admission.push("no_services");
  const probed = snapshot.identity && snapshot.rail && snapshot.services;
  if (probed && !sales) admission.push("readiness_pending");
  if (probed && sales?.database === false && !admission.includes("database_unavailable")) {
    admission.push("database_unavailable");
  }
  if (probed && sales?.servicesReady === false) admission.push("service_unready");
  const allStopped = reads.length > 0 || !probed || !sales?.ready;
  const services = getAllServices();
  const limits: AdmissionCode[] = services.some((service) =>
    service.skills.some((skill) => skill.acceptingNewOrders === false)) ? ["sales_paused"] : [];
  limits.push(...activeSalesStopReasons());
  const jobServices = services.filter(isExternalJobService);
  const jobLimits: AdmissionCode[] = [];
  if (jobServices.length > 0) {
    const posture = externalJobSales();
    if (facts.reachable && !facts.asyncAdmission) jobLimits.push("async_admission_off");
    if (!posture.activeKey) jobLimits.push("encryption_key_missing");
    if (!posture.workerRunning) jobLimits.push("external_job_worker_stopped");
  }
  admission.push(...limits, ...jobLimits);
  // Every installed service sells external jobs and their sales stopped:
  // nothing can be sold, as when complete readiness fails.
  const stopped = allStopped || (jobLimits.length > 0 && jobServices.length === services.length);
  const servicingCodes = [...servicingHealth().codes];
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
  resetSalesReadinessForTests();
  factsCache = null;
  lastEpoch = null;
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

// The same report, with a status code for new sales: 200 only while
// admission is open. For alerting and for gating promotion of a release
// whose sales were already open; never route traffic on it.
healthRouter.get("/admission", async (_req, res) => {
  const report = await healthReport();
  const open = report.admission.status === "open";
  res.status(open ? 200 : 503).json({
    status: open ? "open" : "not_open",
    checkedAt: new Date().toISOString(),
    ...report,
  });
});

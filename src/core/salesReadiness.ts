import { config } from "./config.js";
import { checkDatabase } from "./db/pool.js";
import { getAllServices } from "./serviceRegistry/registry.js";
import type { ServiceModule } from "./serviceRegistry/types.js";

interface DependencyStatus {
  ready: boolean;
  checkedAt: number;
}

const SERVICE_READINESS_TIMEOUT_MS = 3_000;

/** Complete readiness for new sales, as the last probe found it. */
export interface SalesReadiness {
  ready: boolean;
  /** Null when not probed: identity, rail or services were already not ready. */
  database: boolean | null;
  servicesReady: boolean | null;
}

let identity: DependencyStatus = { ready: false, checkedAt: 0 };
let rail: DependencyStatus = { ready: false, checkedAt: 0 };
// Each identity or rail change starts a new generation: a probe that began
// before it can still answer its own callers, but never becomes the cached
// or reported result.
let generation = 0;
let cached: { expiresAt: number; result: SalesReadiness } | null = null;
let lastCompleted: { generation: number; result: SalesReadiness } | null = null;
let inFlight: { generation: number; promise: Promise<SalesReadiness> } | null = null;

export function setProviderIdentityStatus(ready: boolean): void {
  identity = { ready, checkedAt: Date.now() };
  generation += 1;
  cached = null;
}

export function setRailStatus(ready: boolean): void {
  rail = { ready, checkedAt: Date.now() };
  generation += 1;
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

async function probe(now: number): Promise<SalesReadiness> {
  const snapshot = readinessSnapshot(now);
  if (!(snapshot.identity && snapshot.rail && snapshot.services)) {
    return { ready: false, database: null, servicesReady: null };
  }
  const [database, ...serviceStatuses] = await Promise.all([
    checkDatabase(),
    ...getAllServices().map(serviceIsReady),
  ]);
  const servicesReady = serviceStatuses.every(Boolean);
  return { ready: database && servicesReady, database, servicesReady };
}

/**
 * Complete readiness for new sales: identity, rail, an installed service,
 * the database and every service's bounded readiness. Cached briefly;
 * concurrent callers share one probe.
 */
export function salesReadiness(): Promise<SalesReadiness> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return Promise.resolve(cached.result);
  if (inFlight && inFlight.generation === generation) return inFlight.promise;
  const started = generation;
  const promise: Promise<SalesReadiness> = probe(now).then((result) => {
    if (started === generation) {
      cached = { result, expiresAt: Date.now() + config.HEALTH_READINESS_CACHE_MS };
      lastCompleted = { generation: started, result };
    }
    return result;
  }).finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
  });
  inFlight = { generation: started, promise };
  return promise;
}

/** Complete provider readiness for new sales (quotes, the outcome list, new synchronous dispatches). */
export async function providerReady(): Promise<boolean> {
  return (await salesReadiness()).ready;
}

/**
 * Sales readiness for a report that must not wait on a product: the fresh
 * result, or the current probe if it finishes within `budgetMs`, else the
 * last result completed in this generation; null while none exists yet.
 * The probe keeps running and updates the cache when it completes.
 */
export async function salesReadinessWithin(budgetMs: number): Promise<SalesReadiness | null> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
    timer.unref();
  });
  try {
    const result = await Promise.race([salesReadiness(), budget]);
    if (result) return result;
    return lastCompleted?.generation === generation ? lastCompleted.result : null;
  } finally {
    clearTimeout(timer);
  }
}

/** Tests: forget every probe result. */
export function resetSalesReadinessForTests(): void {
  cached = null;
  lastCompleted = null;
  inFlight = null;
  generation += 1;
}

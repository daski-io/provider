import { Router } from "express";
import { config } from "./config.js";
import { checkDatabase } from "./db/pool.js";
import { getAllServices } from "./serviceRegistry/registry.js";
import type { ServiceModule } from "./serviceRegistry/types.js";

interface DependencyStatus {
  ready: boolean;
  checkedAt: number;
}

const SERVICE_READINESS_TIMEOUT_MS = 3_000;
let identity: DependencyStatus = { ready: false, checkedAt: 0 };
let rail: DependencyStatus = { ready: false, checkedAt: 0 };
let cached: { expiresAt: number; ready: boolean } | null = null;

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

async function serviceIsReady(service: ServiceModule): Promise<boolean> {
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

export async function providerReady(): Promise<boolean> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.ready;
  const snapshot = readinessSnapshot(now);
  let ready = snapshot.identity && snapshot.rail && snapshot.services;
  if (ready) {
    const services = getAllServices();
    const [database, ...serviceStatuses] = await Promise.all([
      checkDatabase(),
      ...services.map(serviceIsReady),
    ]);
    ready = database && serviceStatuses.every(Boolean);
  }
  cached = {
    ready,
    expiresAt: now + config.HEALTH_READINESS_CACHE_MS,
  };
  return ready;
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

healthRouter.get("/ready", async (_req, res) => {
  const ready = await providerReady();
  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    checkedAt: new Date().toISOString(),
  });
});

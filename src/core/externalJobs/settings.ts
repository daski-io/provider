import type { Config } from "../config.js";

/**
 * External-job worker settings: worker defaults, not signed protocol
 * constants. Each call to the product is bounded by `callTimeoutMs` and runs
 * under a database lease of `leaseSeconds`, renewed every `leaseRenewMs`
 * and released between calls. At most `maxConcurrentCalls` database-fenced
 * calls run at once across every process sharing the database. A pending
 * job is polled every `pollIntervalSeconds` (or the product's hint), an
 * overdue one at least every `overduePollSeconds`. Transient failures back
 * off exponentially from `backoffBaseSeconds` to `backoffMaxSeconds`, with
 * `jitterRatio` of random spread on core's own delays (never on a product's
 * minimum retry delay).
 */
export interface ExternalJobWorkerSettings {
  callTimeoutMs: number;
  leaseSeconds: number;
  leaseRenewMs: number;
  maxConcurrentCalls: number;
  pollIntervalSeconds: number;
  overduePollSeconds: number;
  backoffBaseSeconds: number;
  backoffMaxSeconds: number;
  jitterRatio: number;
  /** How often an idle worker looks for due work. */
  idleTickMs: number;
}

export const DEFAULT_WORKER_SETTINGS: Readonly<ExternalJobWorkerSettings> = {
  callTimeoutMs: 30_000,
  leaseSeconds: 90,
  leaseRenewMs: 20_000,
  maxConcurrentCalls: 4,
  pollIntervalSeconds: 60,
  overduePollSeconds: 300,
  backoffBaseSeconds: 15,
  backoffMaxSeconds: 1_800,
  jitterRatio: 0.1,
  idleTickMs: 1_000,
};

/**
 * The relations every setting must keep: a lease survives two failed
 * renewals, and a call plus two renewal intervals fit inside one lease, so
 * the holder's fenced write can never race its own lease expiry.
 */
export function validateWorkerSettings(settings: ExternalJobWorkerSettings): ExternalJobWorkerSettings {
  const positive = (value: number) => Number.isFinite(value) && value > 0;
  if (Object.values(settings).some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error("external-job worker settings must be finite numbers");
  }
  if (
    !positive(settings.callTimeoutMs) || !positive(settings.leaseSeconds) || !positive(settings.leaseRenewMs)
    || !Number.isSafeInteger(settings.maxConcurrentCalls) || settings.maxConcurrentCalls < 1
    || !positive(settings.pollIntervalSeconds) || !positive(settings.overduePollSeconds)
    || !positive(settings.backoffBaseSeconds) || settings.backoffMaxSeconds < settings.backoffBaseSeconds
    || settings.jitterRatio < 0 || settings.jitterRatio >= 1 || !positive(settings.idleTickMs)
  ) throw new Error("external-job worker settings are out of range");
  const leaseMs = settings.leaseSeconds * 1_000;
  if (leaseMs < 3 * settings.leaseRenewMs) {
    throw new Error("EXTERNAL_JOB_LEASE_SECONDS must cover at least three lease renewals");
  }
  if (leaseMs < settings.callTimeoutMs + 2 * settings.leaseRenewMs) {
    throw new Error("EXTERNAL_JOB_LEASE_SECONDS must cover a call plus two lease renewals");
  }
  return settings;
}

/** The configured settings (docs/configuration.md), validated. */
export function workerSettingsFromConfig(config: Pick<Config,
  "EXTERNAL_JOB_CALL_TIMEOUT_MS" | "EXTERNAL_JOB_LEASE_SECONDS" | "EXTERNAL_JOB_LEASE_RENEW_MS"
  | "EXTERNAL_JOB_MAX_CONCURRENT_CALLS" | "EXTERNAL_JOB_POLL_INTERVAL_SECONDS"
  | "EXTERNAL_JOB_OVERDUE_POLL_SECONDS">): ExternalJobWorkerSettings {
  return validateWorkerSettings({
    ...DEFAULT_WORKER_SETTINGS,
    callTimeoutMs: config.EXTERNAL_JOB_CALL_TIMEOUT_MS,
    leaseSeconds: config.EXTERNAL_JOB_LEASE_SECONDS,
    leaseRenewMs: config.EXTERNAL_JOB_LEASE_RENEW_MS,
    maxConcurrentCalls: config.EXTERNAL_JOB_MAX_CONCURRENT_CALLS,
    pollIntervalSeconds: config.EXTERNAL_JOB_POLL_INTERVAL_SECONDS,
    overduePollSeconds: config.EXTERNAL_JOB_OVERDUE_POLL_SECONDS,
  });
}

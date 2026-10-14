import { serviceIsReady } from "../health.js";
import { errorExtra, logError } from "../logger.js";
import type { FieldEncryptionKeyRing } from "../security/fieldEncryption.js";
import { externalJobAdapterVersions } from "../serviceRegistry/adapterValidation.js";
import { getAllServices } from "../serviceRegistry/registry.js";
import type { ResultContracts } from "../standardRail/resultContracts.js";
import { claimDueJobs, type ClaimedJob, type ServiceableVersion } from "./jobClaims.js";
import { runJobStep } from "./jobStep.js";
import type { ExternalJobRuntime } from "./runtime.js";
import type { ExternalJobWorkerSettings } from "./settings.js";

/** A worker whose last successful claim round is older than this is not running. */
const STALE_TICK_MS = 60_000;

/** Every (service, adapter version) the registered services can resume. */
export function serviceableVersions(): ServiceableVersion[] {
  return getAllServices().flatMap((service) => externalJobAdapterVersions(service)
    .map((adapterVersion) => ({ serviceSlug: service.manifest.slug, adapterVersion })));
}

/**
 * The durable external-job worker (L04, L06). Each round claims due jobs
 * from the database under fresh leases, at most `maxConcurrentCalls` across
 * every process, and steps each one through its persisted phase; a step's
 * call never keeps a transaction open, and its lease is released between
 * calls. Work is found again from the database after a restart, so nothing
 * is resubmitted merely because a process restarted, and no request ever
 * waits for an upstream job. Waiting is persisted (`next_run_at`), so an
 * eight-hour job costs one short call per poll interval.
 */
export class ExternalJobWorker {
  private readonly inFlight = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private stopped = false;
  private ticking = false;
  private lastTickAt = 0;

  constructor(private readonly deps: {
    owner: string;
    settings: ExternalJobWorkerSettings;
    keys: FieldEncryptionKeyRing;
    resultContracts: ResultContracts;
    random?: () => number;
    now?: () => number;
  }) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(0);
  }

  /** Stop claiming; wait, bounded, for in-flight steps to write their outcome. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const bound = new Promise((resolve) => setTimeout(resolve, this.deps.settings.callTimeoutMs + 5_000).unref());
    await Promise.race([Promise.allSettled([...this.inFlight]), bound]);
  }

  /** Look for due work now (after an admission or a step that finished). */
  wake(): void {
    if (this.started && !this.stopped) this.schedule(0);
  }

  /** Running and claiming: its last successful claim round is recent. */
  running(now = (this.deps.now ?? Date.now)()): boolean {
    return this.started && !this.stopped && now - this.lastTickAt <= STALE_TICK_MS;
  }

  /** The HTTP-facing runtime of this process. */
  runtime(providerAgentId: string): ExternalJobRuntime {
    return {
      keys: this.deps.keys,
      providerAgentId,
      workerRunning: () => this.running(),
      wake: () => this.wake(),
    };
  }

  /**
   * One claim round: claim what is due within the free call slots and step
   * each claimed job. Resolves when every claimed step has finished (tests
   * drive the scheduler with it; the loop does not wait for steps).
   */
  async runDue(): Promise<number> {
    const steps = await this.claimAndStep();
    await Promise.allSettled(steps);
    return steps.length;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.claimAndStep();
    } catch (error) {
      logError("External-job worker could not claim due work", errorExtra(error));
    } finally {
      this.ticking = false;
      this.schedule(this.deps.settings.idleTickMs);
    }
  }

  private async claimAndStep(): Promise<Promise<void>[]> {
    const { settings } = this.deps;
    const free = settings.maxConcurrentCalls - this.inFlight.size;
    const claimed = free < 1 ? [] : await claimDueJobs({
      owner: this.deps.owner,
      limit: free,
      leaseSeconds: settings.leaseSeconds,
      maxConcurrentCalls: settings.maxConcurrentCalls,
      serviceable: serviceableVersions(),
    });
    this.lastTickAt = (this.deps.now ?? Date.now)();
    return claimed.map((job) => this.step(job));
  }

  private step(job: ClaimedJob): Promise<void> {
    const running = runJobStep({
      settings: this.deps.settings,
      keys: this.deps.keys,
      random: this.deps.random ?? Math.random,
      contract: (claimed) => this.deps.resultContracts.forListing(claimed.listingManifestHash, claimed.serviceSlug),
      ready: serviceIsReady,
    }, job).catch((error) => {
      logError("External job step escaped", { taskId: job.taskId, ...errorExtra(error) });
    }).finally(() => {
      this.inFlight.delete(running);
      // A finished step frees a call slot; due work need not wait a tick.
      this.wake();
    });
    this.inFlight.add(running);
    return running;
  }
}

import type { ExternalJobWorkerSettings } from "./settings.js";

/**
 * When a job runs next, in whole seconds from now (database clock).
 *
 * - A pending poll waits the ordinary poll interval and never consumes the
 *   failure budget.
 * - A transient failure or an unresolved recovery backs off exponentially
 *   from the base delay, bounded by the maximum.
 * - Overdue work keeps its bounded overdue cadence (five minutes by
 *   default) and is never polled faster.
 * - Core's own delay carries a small random spread; a product's minimum
 *   delay (`pollAfterSeconds`, `retryAfterSeconds`) is always honored as a
 *   floor and never shortened, even if it reaches past the deadline.
 */
export function nextRunDelaySeconds(args: {
  kind: "pending" | "failure";
  /** Consecutive failures including this one (for `failure`). */
  failures: number;
  overdue: boolean;
  hintSeconds: number | null;
  settings: ExternalJobWorkerSettings;
  random: () => number;
}): number {
  const { settings } = args;
  let base = args.kind === "pending"
    ? settings.pollIntervalSeconds
    : Math.min(
      settings.backoffMaxSeconds,
      settings.backoffBaseSeconds * 2 ** Math.min(Math.max(args.failures, 1) - 1, 30),
    );
  if (args.overdue) base = Math.max(base, settings.overduePollSeconds);
  const spread = 1 + settings.jitterRatio * (2 * Math.min(Math.max(args.random(), 0), 1) - 1);
  const jittered = Math.max(1, Math.round(base * spread));
  return Math.max(jittered, args.hintSeconds ?? 0);
}

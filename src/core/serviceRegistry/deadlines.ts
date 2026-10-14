import type { SkillContractDefinition } from "./manifestTypes.js";

/** Published when a skill declares no dispatch deadline (the gateway's own default). */
export const DEFAULT_DISPATCH_SECONDS = 300;
/** Published when a skill declares no fulfillment window. */
export const DEFAULT_FULFILLMENT_SECONDS = 900;
/** The synchronous mode's execution budget, not Daski's maximum service duration. */
export const SYNC_EXECUTION_BUDGET_SECONDS = 50;
/**
 * After a no-claim status answer the gateway replaces an unanswered dispatch
 * envelope only from its validBefore plus this grace.
 */
export const DISPATCH_EXPIRY_GRACE_SECONDS = 60;
/**
 * Reviewed slack on top of one recovered dispatch: one step of the gateway's
 * refusal backoff (at most 60 seconds), its ten-second status polling, a
 * provider transport timeout and the 30-second clock tolerance both sides
 * allow.
 */
export const SYNC_RECOVERY_MARGIN_SECONDS = 120;

const MIN_DEADLINE_SECONDS = 30;
const MAX_DISPATCH_SECONDS = 86_400;
const MAX_FULFILLMENT_SECONDS = 31_536_000;

export interface SkillDeadlines {
  dispatchSeconds: number;
  fulfillmentSeconds: number;
}

/** The deadlines every published skill contract carries, defaults applied. */
export function skillDeadlines(skill: Pick<SkillContractDefinition, "deadlines">): SkillDeadlines {
  return {
    dispatchSeconds: skill.deadlines?.dispatchSeconds ?? DEFAULT_DISPATCH_SECONDS,
    fulfillmentSeconds: skill.deadlines?.fulfillmentSeconds ?? DEFAULT_FULFILLMENT_SECONDS,
  };
}

/**
 * The shortest fulfillment window that still lets the gateway recover a lost
 * initial dispatch of a synchronous skill. The gateway re-dispatches a paid
 * order only until its first release observation plus the snapshot
 * fulfillment window, and may replace an unanswered envelope only after that
 * envelope's validBefore (dispatchSeconds) plus 60 seconds; the replacement
 * then runs for up to the 50-second synchronous budget.
 */
export function minimumSynchronousFulfillmentSeconds(dispatchSeconds: number): number {
  return dispatchSeconds + DISPATCH_EXPIRY_GRACE_SECONDS + SYNC_EXECUTION_BUDGET_SECONDS
    + SYNC_RECOVERY_MARGIN_SECONDS;
}

/** Refuse deadlines the gateway would reject or a lost dispatch could not survive. */
export function assertSynchronousDeadlines(label: string, deadlines: SkillDeadlines): void {
  const { dispatchSeconds, fulfillmentSeconds } = deadlines;
  if (
    !Number.isSafeInteger(dispatchSeconds) || dispatchSeconds < MIN_DEADLINE_SECONDS
    || dispatchSeconds > MAX_DISPATCH_SECONDS
  ) throw new Error(`${label} dispatchSeconds must be an integer from 30 to 86400`);
  if (
    !Number.isSafeInteger(fulfillmentSeconds) || fulfillmentSeconds < MIN_DEADLINE_SECONDS
    || fulfillmentSeconds > MAX_FULFILLMENT_SECONDS
  ) throw new Error(`${label} fulfillmentSeconds must be an integer from 30 to 31536000`);
  const minimum = minimumSynchronousFulfillmentSeconds(dispatchSeconds);
  if (fulfillmentSeconds < minimum) {
    throw new Error(
      `${label} fulfillmentSeconds must be at least ${minimum} (dispatchSeconds + 60 + 50 + 120) `
      + "so the gateway can recover a lost synchronous dispatch",
    );
  }
}

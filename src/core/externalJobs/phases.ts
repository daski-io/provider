/**
 * The internal phases of one external job (provider_external_jobs.phase).
 * Wire states stay the gateway's: queued answers `submitted`; starting,
 * reconciling and polling answer `working`; completed and failed are the
 * claim's frozen terminal states. An overdue marker and a result diagnostic
 * are orthogonal to the phase, never phases or wire states of their own.
 */
export const ACTIVE_JOB_PHASES = ["queued", "starting", "reconciling", "polling"] as const;
export const FINISHED_JOB_PHASES = ["completed", "failed"] as const;

export type ActiveJobPhase = typeof ACTIVE_JOB_PHASES[number];
export type ExternalJobPhase = ActiveJobPhase | typeof FINISHED_JOB_PHASES[number];

/** The provider_external_jobs table every job statement names. */
export const JOB_TABLE = "provider_external_jobs";

export const isActiveJobPhase = (phase: unknown): phase is ActiveJobPhase =>
  (ACTIVE_JOB_PHASES as readonly unknown[]).includes(phase);

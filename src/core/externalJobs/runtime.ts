import { config as coreConfig } from "../config.js";
import type { FieldEncryptionKeyRing } from "../security/fieldEncryption.js";
import type { ProviderStandardRailConfig } from "../standardRail/config.js";
import { externalJobKeyRing } from "./keyRing.js";

/** What the HTTP routes need from this process's external-job runtime. */
export interface ExternalJobRuntime {
  /** The configured key ring; its active key seals every new job. */
  keys: FieldEncryptionKeyRing;
  /** This provider's ERC-8004 agent id, part of every job's idempotency key. */
  providerAgentId: string;
  /** True while this process's worker loop keeps claiming due work. */
  workerRunning(): boolean;
  /** Ask the worker to look for due work now, e.g. right after an admission. */
  wake(): void;
}

/**
 * A runtime without a worker: funded external-job dispatches are still
 * admitted durably, but new external-job sales stop, since nothing in this
 * process would progress them.
 */
export function idleExternalJobRuntime(
  keys: FieldEncryptionKeyRing,
  providerAgentId: string,
): ExternalJobRuntime {
  return { keys, providerAgentId, workerRunning: () => false, wake: () => undefined };
}

/** The configured keys and identity, without a worker (see idleExternalJobRuntime). */
export function defaultExternalJobRuntime(
  standard: Pick<ProviderStandardRailConfig, "retainedSigningKeys">,
): ExternalJobRuntime {
  return idleExternalJobRuntime(
    externalJobKeyRing(coreConfig, standard.retainedSigningKeys.values()),
    coreConfig.PROVIDER_AGENT_ID.toString(),
  );
}

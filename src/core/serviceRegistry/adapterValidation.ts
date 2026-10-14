import type { ExternalJobAdapter, ServiceAdapter } from "./adapterTypes.js";
import type { ServiceModule } from "./serviceModule.js";

/**
 * An adapter version names how its job references are interpreted. It is
 * persisted with every job and selects the adapter that resumes it.
 */
export const ADAPTER_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The longest upstream same-key replay guarantee core records (one year). */
export const MAX_IDEMPOTENCY_RETENTION_SECONDS = 31_536_000;

export type AdapterMode = "sync" | "external-job";

/** The mode a registered adapter runs in; anything else is refused at registration. */
export function adapterMode(adapter: ServiceAdapter): AdapterMode {
  return adapter.mode === "external-job" ? "external-job" : "sync";
}

function assertExternalJobAdapter(label: string, value: unknown): asserts value is ExternalJobAdapter {
  const adapter = value as Record<string, unknown> | null;
  if (!adapter || typeof adapter !== "object" || adapter.mode !== "external-job") {
    throw new Error(`${label} must be an external-job adapter`);
  }
  if (typeof adapter.version !== "string" || !ADAPTER_VERSION_PATTERN.test(adapter.version)) {
    throw new Error(`${label} needs a version of 1 to 64 letters, digits, '.', '_' or '-'`);
  }
  for (const method of ["start", "recoverStart", "poll"] as const) {
    if (typeof adapter[method] !== "function") throw new Error(`${label} must implement ${method}`);
  }
  const retention = adapter.idempotencyRetentionSeconds;
  if (
    retention !== undefined
    && (!Number.isSafeInteger(retention) || (retention as number) < 1
      || (retention as number) > MAX_IDEMPOTENCY_RETENTION_SECONDS)
  ) {
    throw new Error(`${label} idempotencyRetentionSeconds must be an integer from 1 to 31536000`);
  }
}

/**
 * The service's adapter has exactly one reviewed mode: synchronous (no mode
 * or `"sync"`, with `execute`) or `"external-job"` (version, start,
 * recoverStart, poll). Retained previous external-job adapters are keyed by
 * exactly their own version, distinct from the current adapter's, so a
 * persisted job version selects one adapter unambiguously.
 */
export function assertServiceAdapters(module: ServiceModule): void {
  const slug = module.manifest.slug;
  const adapter = module.adapter as unknown as Record<string, unknown> | null;
  if (!adapter || typeof adapter !== "object") throw new Error(`Service ${slug} has no adapter`);
  if (adapter.mode === undefined || adapter.mode === "sync") {
    if (typeof adapter.execute !== "function") {
      throw new Error(`Service ${slug} synchronous adapter must implement execute`);
    }
  } else {
    assertExternalJobAdapter(`Service ${slug} adapter`, adapter);
  }
  const previous = module.previousExternalJobAdapters;
  if (previous === undefined) return;
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) {
    throw new Error(`Service ${slug} previousExternalJobAdapters must be a record`);
  }
  for (const [version, retained] of Object.entries(previous)) {
    const label = `Service ${slug} previous adapter ${version}`;
    assertExternalJobAdapter(label, retained);
    if (retained.version !== version) throw new Error(`${label} is keyed by another version`);
    if (adapter.mode === "external-job" && adapter.version === version) {
      throw new Error(`${label} repeats the current adapter's version`);
    }
  }
}

/** Every external-job adapter version this module can resume, current first. */
export function externalJobAdapterVersions(module: ServiceModule): string[] {
  const versions = module.adapter.mode === "external-job" ? [module.adapter.version] : [];
  return [...versions, ...Object.keys(module.previousExternalJobAdapters ?? {})];
}

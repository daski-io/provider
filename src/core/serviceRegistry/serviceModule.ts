import type { ExternalJobAdapter, ServiceAdapter } from "./adapterTypes.js";
import type { ServiceManifest, SkillDefinition } from "./manifestTypes.js";
import type { RequestReadiness, RequestReadinessContext } from "./requestReadiness.js";

export interface ServiceModule {
  manifest: ServiceManifest;
  skills: SkillDefinition[];
  /**
   * The adapter new sales use: a synchronous `FulfillmentAdapter` (no mode,
   * or `mode: "sync"`) or an `ExternalJobAdapter` (`mode: "external-job"`).
   * The mode belongs to the whole service; `context.skillId` selects the
   * operation.
   */
  adapter: ServiceAdapter;
  /**
   * External-job adapters retained for orders sold or jobs admitted under an
   * earlier version, keyed by exactly their `version` (never the current
   * adapter's). An order is admitted under the version that sold its quote
   * and its job is resumed by that version, even after new sales move to
   * another version or mode; nothing is loaded from the database or a
   * dynamic module path.
   */
  previousExternalJobAdapters?: Readonly<Record<string, ExternalJobAdapter>>;
  /** Bounded, read-only proof that the product can accept paid work now. */
  readiness(signal: AbortSignal): Promise<boolean>;
  /**
   * Optional read-only check of one schema-valid request, run before each new
   * quote. Decline with reviewed field errors; a service that needs an
   * identified payer declines an unbound (null) payer. It cannot change the
   * fixed price and must never start work, reserve capacity, or purchase.
   * Funded dispatches never re-run it.
   */
  requestReadiness?(context: RequestReadinessContext): Promise<RequestReadiness>;
  /**
   * Reviewed lowercase failure codes the service's adapters may return: the
   * current adapter and every retained previous one, since a job is judged
   * against this one list whichever version admitted it. Keep a code listed
   * while any installed adapter version can still return it. A failed result
   * is attested as exactly `{status: "failed", errorCode}`: its message is
   * dropped and any code not listed here (or core's own) becomes
   * `service_execution_failed`, so failure evidence never carries free text.
   */
  failureCodes?: readonly string[];
  docs: {
    service: string;
    skills: Record<string, string>;
  };
}

import type { FulfillmentAdapter } from "./adapterTypes.js";
import type { ServiceManifest, SkillDefinition } from "./manifestTypes.js";
import type { RequestReadiness, RequestReadinessContext } from "./requestReadiness.js";

export interface ServiceModule {
  manifest: ServiceManifest;
  skills: SkillDefinition[];
  adapter: FulfillmentAdapter;
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
  docs: {
    service: string;
    skills: Record<string, string>;
  };
}

import type { FulfillmentAdapter } from "./adapterTypes.js";
import type { ServiceManifest, SkillDefinition } from "./manifestTypes.js";

export interface ServiceModule {
  manifest: ServiceManifest;
  skills: SkillDefinition[];
  adapter: FulfillmentAdapter;
  /** Bounded, read-only proof that the product can accept paid work now. */
  readiness(signal: AbortSignal): Promise<boolean>;
  docs: {
    service: string;
    skills: Record<string, string>;
  };
}

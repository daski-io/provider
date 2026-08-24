import type { SkillPricing } from "../pricing/index.js";

export interface AssetTypeLifecycle {
  states: string[];
  terminalStates: string[];
  transitions: Array<{ from: string | null; to: string; skill: string }>;
}

export type CategoryFamily =
  | "business-formation"
  | "legal-ip"
  | "compliance"
  | "finance"
  | "domains-web"
  | "communications"
  | "compute-ai"
  | "data"
  | "software-dev"
  | "design-creative"
  | "marketing-growth"
  | "sales-support"
  | "human-talent"
  | "operations-admin"
  | "logistics-physical"
  | "other";

export type FulfillmentMode = "automated" | "human" | "hybrid";
export type TaskDurability = "persistent" | "ephemeral";

export interface ServiceManifest {
  slug: string;
  version?: string;
  name: string;
  categoryFamily: CategoryFamily;
  serviceType: string;
  jurisdictions: string[];
  description: string;
  agentDomain?: string;
  turnaroundEstimate: string;
  serviceLifecycle: "one-shot" | "asset-lifecycle";
  dispatchMode: "one-shot" | "durable";
  defaultFulfillmentMode: FulfillmentMode;
  defaultTags?: string[];
  supplier?: string;
  outboundEmailFrom?: string;
  inboundEmailAddress?: string;
  serviceWallet?: string;
  support?: {
    emailAuthoritativeFor: string[];
    skillRequiredFor: string[];
  };
  assetLifecycle?: Record<string, AssetTypeLifecycle>;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  examples: string[];
  pricing: SkillPricing;
  /**
   * Opt-in short retention for open, free, automated reads that create no
   * service-owned durable state. All other skills remain persistent.
   */
  taskDurability?: "ephemeral";
  fulfillmentMode?: FulfillmentMode;
  requiresAssetOwnership: boolean;
  assetType?: string;
  requiredFields?: string[];
  optionalFields?: string[];
  tags?: string[];
  sortOrder?: number;
  humanParties?: "required" | "varies" | "none";
  documentationUrl?: string;
}

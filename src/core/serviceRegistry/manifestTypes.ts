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

export interface ServiceManifest {
  slug: string;
  version: string;
  name: string;
  description: string;
  categoryFamily: CategoryFamily;
  serviceType: string;
  jurisdictions: string[];
  turnaroundEstimate: string;
  tags?: string[];
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  examples: string[];
  /** Fixed USDC amount in 6-decimal atomic units. */
  fixedPriceAtomic: string;
  requiredFields?: string[];
  optionalFields?: string[];
  tags?: string[];
}

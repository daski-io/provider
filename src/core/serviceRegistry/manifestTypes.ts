/** Open normalized identifier; recommended values live in public docs. */
export type CategoryFamily = string;

export type ClosedJsonSchema = Record<string, unknown>;

export interface SkillContractDefinition {
  inputSchema: ClosedJsonSchema;
  resultSchema: ClosedJsonSchema;
  acceptingNewOrders?: boolean;
  capacity?: { maxOpenOrders: number };
  deadlines?: {
    dispatchSeconds?: number;
    fulfillmentSeconds?: number;
  };
}

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

export interface SkillDefinition extends SkillContractDefinition {
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

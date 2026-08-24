import type { Router } from "express";
import type { EmailAgentTool } from "../agents/emailAgent/tools/context.js";
import type { OperatorTool } from "../agents/operatorAgent/tools/shared.js";
import type {
  AssetStatus,
  ProtectedAssetIdentifierScheme,
} from "../db/queries/assets.js";
import type { ProtectedDataSink } from "../security/protectedDataSinkTypes.js";
import type { FulfillmentAdapter } from "./adapterTypes.js";
import type { ServiceScreeningFacet } from "../screening/types.js";
import type {
  InboundEmailInterceptor,
  PreExecuteAgentConfig,
  PreExecuteReviewDataArgs,
  ServiceAdminExtension,
  ServiceMigration,
  ServiceReadiness,
} from "./extensionTypes.js";
import type {
  ServiceManifest,
  SkillDefinition,
} from "./manifestTypes.js";

export interface ServiceFulfillmentFacet {
  adapter: FulfillmentAdapter;
  preExecuteAgent?: Record<string, PreExecuteAgentConfig>;
  buildPreExecuteReviewData?(
    args: PreExecuteReviewDataArgs,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface ServiceProtocolFacet {
  docs: {
    service: string;
    skills: Record<string, string>;
  };
  routes?: (router: Router) => void;
  inboundEmail?: InboundEmailInterceptor;
}

export interface ServiceOperationsFacet {
  migrations?: ServiceMigration[];
  seed?: () => Promise<void>;
  startWorkers?(): (() => void | Promise<void>) | void;
  readiness?: ServiceReadiness;
}

export interface ServiceAgentFacet {
  emailAgentTools?(): EmailAgentTool[];
  operatorAgentTools?(): OperatorTool[];
  operatorAgentActionTools?(): OperatorTool[];
}

export interface ServiceSecurityFacet {
  protectedDataSinks?: ProtectedDataSink[];
  protectedAssetIdentifiers?: Record<
    string,
    ProtectedAssetIdentifierScheme
  >;
  redactSensitiveFields?(
    skillId: string,
    data: Record<string, unknown>,
  ): Record<string, unknown>;
}

export type AssetOwnershipPolicy = "owner-only" | "any-payer";

export interface ServiceAssetFacet {
  assetIdentifierFromData?(
    skillId: string,
    data: Record<string, unknown>,
  ): string | null | undefined | Promise<string | null | undefined>;
  assetLookupStatuses?(skillId: string): AssetStatus[] | undefined;
  assetOwnershipPolicy?(
    skillId: string,
  ): AssetOwnershipPolicy | undefined;
}

/** Complete service plug-in contract, grouped by core responsibility. */
export interface ServiceModule {
  manifest: ServiceManifest;
  skills: SkillDefinition[];
  fulfillment: ServiceFulfillmentFacet;
  protocol: ServiceProtocolFacet;
  operations?: ServiceOperationsFacet;
  agents?: ServiceAgentFacet;
  security?: ServiceSecurityFacet;
  assets?: ServiceAssetFacet;
  screening?: ServiceScreeningFacet;
  admin?: ServiceAdminExtension;
}

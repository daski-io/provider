import type { Queryable } from "../db/queryable.js";
import type { AssetRow } from "../db/queries/assets.js";
import type { ProtectedDataSink } from "../security/protectedDataSinkTypes.js";
import type { OperatorTool } from "../agents/operatorAgent/tools/shared.js";
import type { ServiceAdminExtension, ServiceMigration, ServiceReadiness } from "../serviceRegistry/extensionTypes.js";
import type { TrustedRequestCountry } from "../security/trustedRequestCountry.js";

export type ScreeningDecisionKind = "allow" | "reject" | "hold" | "unavailable";
export type ScreeningPhase = "quote" | "post-payment" | "execution" | "policy-sweep";

export interface ScreeningSubject {
  kind: "person" | "company";
  name: string;
  role: string;
  fieldPath: string;
  dob?: string | null;
  addressCountry?: string | null;
  addressState?: string | null;
  addressCity?: string | null;
  phone?: string | null;
  jurisdictionCountry?: string | null;
  trustedRequestCountry?: TrustedRequestCountry | null;
  identifiers?: string[];
}

export interface ScreeningSubmission {
  subjects?: ScreeningSubject[];
  assetIdentifier?: string | null;
  loadAssetProfile?: boolean;
  noApplicableSubjects?: boolean;
}

export interface ScreeningDecision {
  decision: ScreeningDecisionKind;
  decisionId: string;
  ruleIds: string[];
  policyVersion: string;
  policyHash: string;
  evidenceFingerprint: string;
  listVersion?: string | null;
  retryable: boolean;
}

export interface ScreeningEvaluationRequest {
  serviceSlug: string;
  serviceId?: string;
  skillId: string;
  phase: ScreeningPhase;
  subjects?: ScreeningSubject[];
  assetIdentifier?: string | null;
  loadAssetProfile?: boolean;
  transactionId?: string | null;
  assetId?: string | null;
  requireCurrentList?: boolean;
}

export interface ScreeningSweepTarget {
  serviceSlug: string;
  serviceId: string;
  skillId: string;
  assetId: string;
  subjects: ScreeningSubject[];
}

export interface ScreeningPolicyView {
  schemaVersion: "1";
  policyVersion: string;
  rulesVersion: string;
  countryMappingVersion: string;
  nameScorerVersion: string;
  sourceIds: readonly string[];
  tiers: Readonly<Record<"tier1" | "tier2" | "tier3", readonly string[]>>;
  serviceBindings: Readonly<Record<string, {
    activeTiers: readonly ("tier1" | "tier2" | "tier3")[];
    quoteNameMode: "none" | "reject";
    postPaymentNameMode: "none" | "hold";
    exactMode: "reject" | "hold";
    aliasMode: "reject" | "hold";
    partialMode: "evaluate";
  }>>;
  countryAliases: Readonly<Record<string, readonly string[]>>;
  restrictedRegions: readonly {
    id: string;
    subdivisionCodes: readonly string[];
    aliases: readonly string[];
  }[];
  callingCodes: Readonly<Record<string, readonly string[]>>;
  thresholds: Readonly<{
    personWeakMatchThreshold: number;
    companyWeakMatchThreshold: number;
  }>;
  r1: Readonly<{
    yearTolerance: number;
    monthContradiction: boolean;
    dayContradiction: boolean;
    exactNameEligible: boolean;
  }>;
  r2: Readonly<{ minimumSignals: number; postHoldAttestationEligible: boolean }>;
  r3: Readonly<{
    partialOnly: boolean;
    corroborationGuard: boolean;
    unparseableCandidateDataHolds: boolean;
  }>;
  adjudicationMemoryTtlDays: number;
  vendorCacheTtlHours: number;
  sweepIntervalHours: number;
}

export interface ScreeningVendorEntry {
  id: string;
  sourceId: string;
  sourceType?: string;
  listId: string;
  name: string;
  aliases?: string[];
  score?: number;
  vendorScore?: number;
  scoreComparable?: boolean;
  scoreVersion?: string;
  matchType?: "exact" | "alias" | "partial";
  entityType?: string;
  transliteratedName?: string;
  nameRemarks?: string[];
  dobs?: string[];
  countries?: string[];
  placesOfBirth?: string[];
  addresses?: string[];
  companyNumbers?: string[];
  identifiers?: string[];
  listDates?: string[];
  programs?: string[];
  raw?: unknown;
}

export interface ScreeningProviderExtension {
  id: string;
  version: string;
  scopes: readonly string[];
  policy: ScreeningPolicyView;
  policyHash: string;
  migrations?: ServiceMigration[];
  protectedDataSinks?: ProtectedDataSink[];
  readiness?: ServiceReadiness;
  seed?(): Promise<void>;
  startWorkers?(): (() => void | Promise<void>) | void;
  admin?: ServiceAdminExtension;
  reviewStatusHtml?(): Promise<string>;
  reviewEvidence?(target: {
    type: string;
    id: string;
  }): Promise<{
    sections: Array<{
      title: string;
      fields: Array<{ label: string; value: string | string[] | null }>;
    }>;
  } | null>;
  operatorTools?(): OperatorTool[];
  evaluate(request: ScreeningEvaluationRequest): Promise<ScreeningDecision>;
  screenVendorSubject(subject: ScreeningSubject): Promise<ScreeningVendorEntry[]>;
  storeAssetProfile(args: {
    asset: AssetRow;
    serviceSlug: string;
    subjects: ScreeningSubject[];
    db: Queryable;
  }): Promise<void>;
  bindTransactionAsset(args: {
    transactionId: string;
    assetId: string;
    db?: Queryable;
  }): Promise<void>;
  hasActiveRestriction(args: {
    serviceSlug: string;
    assetId?: string | null;
    assetIdentifier?: string | null;
    transactionId?: string | null;
    db?: Queryable;
  }): Promise<boolean>;
  hasBlockingTransaction(
    transactionId: string,
    db?: Queryable,
    options?: { includeRetryable?: boolean },
  ): Promise<boolean>;
  normalizeCountry(value: string): { normalized: string; iso2: string | null };
  phoneCountryCandidates(phone: string | null | undefined): string[] | null;
}

export interface ServiceScreeningFacet {
  requiredScopes: string[];
  extractQuoteSubjects(args: {
    skillId: string;
    data: Record<string, unknown>;
    asset: AssetRow | null;
  }): ScreeningSubmission | Promise<ScreeningSubmission>;
  extractAssetProfile?(args: {
    skillId: string;
    data: Record<string, unknown>;
    asset: AssetRow;
  }): ScreeningSubject[] | Promise<ScreeningSubject[]>;
  /** Service-owned roster translation consumed by the extension's policy worker. */
  listPolicySweepTargets?(): Promise<ScreeningSweepTarget[]>;
}

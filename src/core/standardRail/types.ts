import type { Hex } from "viem";

export interface SignedEnvelope<T, V extends 1 | 2 = 1> {
  artifactType: string;
  schemaVersion: V;
  environment: string;
  chainId: number;
  audience: string;
  signerKeyId: string;
  issuedAt: number;
  validBefore: number;
  payload: T;
  signature: Hex;
}

export interface StandardRailDispatchV2 {
  environment: string;
  chainId: number;
  gatewayAudience: string;
  providerAudience: string;
  providerControlProfileHash: Hex;
  orderId: string;
  orderKey: Hex;
  serviceId: Hex;
  reputationEligible: boolean;
  reputationContract: Hex;
  outcomeSchemaUid: Hex;
  dispatchNonce: Hex;
  payer: Hex;
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  quoteHash: Hex;
  bindingProfile: "stock-fixed-v1" | "recipe-bound-v1";
  canonicalRequestHash: Hex;
  orderNonce: Hex;
  buyerIdentityProofHash: Hex;
  activeRailProfileHash: Hex;
  facilitatorConfirmationHash: Hex;
  settlementTxHash: Hex;
  depositBlockNumber: string;
  depositBlockHash: Hex;
  depositTransactionIndex: number;
  depositLogIndex: number;
  depositEvidenceHash: Hex;
  releaseTxHash: Hex;
  releaseBlockNumber: string;
  releaseBlockHash: Hex;
  releaseTransactionIndex: number;
  releaseLogIndex: number;
  releaseSequence: string;
  releaseEvidenceHash: Hex;
  grossAmount: string;
  providerNetAmount: string;
  daskiCommissionAmount: string;
  canonicalProviderRequestHash: Hex;
  dispatchDeadlineSeconds: number;
  issuedAt: number;
  validBefore: number;
}

export interface QuoteV1 {
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  providerQuoteHash: Hex;
  canonicalRequestHash: Hex;
  grossAmount: string;
  token: Hex;
  splitter: Hex;
  orderNonce: Hex;
  issuedAt: number;
  validBefore: number;
}

export interface DispatchStatusQueryV1 {
  orderId: string;
  dispatchHash: Hex;
  issuedAt: number;
  validBefore: number;
}

export interface ProviderOutcomeOfferV1 {
  listingManifestHash: Hex;
  outcomeId: string;
  skillId: string;
  providerAgentId: string;
  providerPayee: Hex;
  pricingMode: "fixed";
  fixedGrossAmount: string;
  quotePolicyHash: Hex;
  capacityPolicyHash: Hex;
  deadlinePolicyHash: Hex;
  deliveryCommitment: Hex;
  termsHash: Hex;
  issuedAt: number;
  validBefore: number;
  offerNonce: Hex;
}

export interface StandardEvidenceBundleV2 {
  deposit: {
    transactionHash: Hex;
    blockNumber: string;
    blockHash: Hex;
    transactionIndex: number;
    logIndex: number;
    evidenceHash: Hex;
    canonicalEvidence: Record<string, unknown>;
    sources: string[];
  };
  release: {
    transactionHash: Hex;
    blockNumber: string;
    blockHash: Hex;
    transactionIndex: number;
    logIndex: number;
    releaseSequence: string;
    evidenceHash: Hex;
    canonicalEvidence: Record<string, unknown>;
    sources: string[];
  };
}

export interface ProviderOutcomeConfig {
  outcomeId: string;
  serviceSlug: string;
  serviceId: Hex;
  skillId: string;
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  pricingMode: "fixed";
  fixedGrossAmount: string;
  quoteMaximumLifetimeSeconds: 0;
  quoteMinimumPaymentWindowSeconds: 0;
  providerControlProfileHash: Hex;
  activeRailProfileHash: Hex;
  customerIdentityPolicyId: "none";
  token: Hex;
  splitter: Hex;
  splitterFactory: Hex;
  splitterFactoryRuntimeCodeHash: Hex;
  splitterCreationCode: Hex;
  splitterCreationCodeHash: Hex;
  splitterInitCodeHash: Hex;
  splitterDeploymentSalt: Hex;
  splitterRuntimeCodeHash: Hex;
  splitterDeploymentTransaction: Hex;
  splitterDeploymentBlockNumber: string;
  splitterDeploymentBlockHash: Hex;
  splitterActivationBlockNumber: string;
  splitterActivationBlockHash: Hex;
  splitterActivationPosition: "END_OF_BLOCK";
  splitterStartingTokenBalance: string;
  splitterStartingReleaseSequence: string;
  tokenRuntimeCodeHash: Hex;
  tokenImplementationAddress: Hex;
  tokenImplementationRuntimeCodeHash: Hex;
  tokenImplementationSlot: Hex;
  tokenDomainSeparator: Hex;
  sanctionsOracleRuntimeCodeHash: Hex;
  providerControlledWallets: Hex[];
  maximumSourceLagBlocks: number;
  maximumLogPageEvents: number;
  listingCommitmentHash: Hex;
  outcomeIdHash: Hex;
  policyVersionHash: Hex;
  listingEpoch: string;
  providerPayee: Hex;
  providerTerminalAttestationKey: Hex;
  daskiCommissionReceiver: Hex;
  commissionBps: number;
  maxOpenOrders: number;
  dispatchDeadlineSeconds: number;
  bindingProfile: "stock-fixed-v1" | "recipe-bound-v1";
  requestSchema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
    additionalProperties: false;
  };
}

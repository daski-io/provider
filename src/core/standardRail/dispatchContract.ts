export const STANDARD_DISPATCH_PAYLOAD_KEYS = [
  "environment", "chainId", "gatewayAudience", "providerAudience", "providerControlProfileHash",
  "orderId", "orderKey", "serviceId", "reputationEligible", "reputationContract",
  "outcomeSchemaUid", "dispatchNonce", "payer", "listingManifestHash", "providerOfferHash", "quoteHash",
  "bindingProfile", "canonicalRequestHash", "orderNonce", "buyerIdentityProofHash",
  "activeRailProfileHash", "facilitatorConfirmationHash",
  "settlementTxHash", "depositBlockNumber", "depositBlockHash", "depositTransactionIndex",
  "depositLogIndex", "depositEvidenceHash",
  "releaseTxHash", "releaseBlockNumber", "releaseBlockHash", "releaseTransactionIndex",
  "releaseLogIndex", "releaseSequence", "releaseEvidenceHash", "grossAmount", "providerNetAmount",
  "daskiCommissionAmount", "canonicalProviderRequestHash",
  "dispatchDeadlineSeconds", "issuedAt", "validBefore",
] as const;

/** Gateway order ids are `ord_` plus a lowercase version-4 UUID. */
export const ORDER_ID_PATTERN = /^ord_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HASH32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

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

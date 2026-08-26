import {
  getAddress,
  keccak256,
  recoverMessageAddress,
  stringToHex,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ValidateFunction } from "ajv";
import { getAdapter, getService, getSkill } from "../serviceRegistry/registry.js";
import type { ServiceResult } from "../serviceRegistry/types.js";
import {
  assertExactKeys,
  canonicalHash,
  SIGNED_ENVELOPE_KEYS,
  unsignedEnvelopeHash,
} from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { STANDARD_DISPATCH_PAYLOAD_KEYS } from "./dispatchContract.js";
import { ProviderEvidenceVerifier } from "./evidence.js";
import { admitStandardEvidence } from "./evidenceAdmissions.js";
import {
  assertDispatchWithinQuoteSettlementWindow,
  assertFixedQuotePolicy,
} from "./paymentBinding.js";
import { compileProviderSchema, validateProviderRequest } from "./schema.js";
import {
  claimTransaction,
  completeTransaction,
  findTransaction,
  type ProviderTransaction,
} from "./transactionStore.js";
import type {
  DispatchStatusQueryV1,
  ProviderOutcomeConfig,
  QuoteV1,
  SignedEnvelope,
  StandardEvidenceBundleV2,
  StandardRailDispatchV2,
} from "./types.js";

const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const MAX_RESULT_BYTES = 1_000_000;
const MAX_EXECUTION_MS = 50_000;

export class StandardDispatchService {
  private readonly evidence: ProviderEvidenceVerifier;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(
    private readonly config: ProviderStandardRailConfig,
    chain: Chain,
    private readonly chainId: number,
  ) {
    this.evidence = new ProviderEvidenceVerifier(config, chain);
    for (const outcome of config.outcomes.values()) {
      this.validators.set(
        outcome.outcomeId,
        compileProviderSchema(outcome.requestSchema as unknown as Record<string, unknown>),
      );
    }
  }

  async status(envelope: SignedEnvelope<DispatchStatusQueryV1>) {
    assertExactKeys(envelope, SIGNED_ENVELOPE_KEYS, "dispatch status envelope");
    assertExactKeys(
      envelope.payload,
      ["orderId", "dispatchHash", "issuedAt", "validBefore"],
      "dispatch status payload",
    );
    const now = Math.floor(Date.now() / 1_000);
    if (
      envelope.artifactType !== "DispatchStatusQueryV1"
      || envelope.schemaVersion !== 1
      || envelope.environment !== this.config.environment
      || envelope.chainId !== this.chainId
      || envelope.audience !== this.config.providerAudience
      || envelope.issuedAt !== envelope.payload.issuedAt
      || envelope.validBefore !== envelope.payload.validBefore
      || envelope.issuedAt > now + 30
      || envelope.validBefore <= now
      || envelope.validBefore > now + 120
    ) throw new Error("Dispatch status query domain is invalid");
    const recovered = await recoverMessageAddress({
      message: { raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>) },
      signature: envelope.signature,
    });
    if (getAddress(recovered) !== this.config.gatewayDispatchSigner) {
      throw new Error("Dispatch status query signature is invalid");
    }
    const transaction = await findTransaction(
      this.config.gatewayAudience,
      envelope.payload.orderId,
    );
    if (
      !transaction
      || `0x${transaction.dispatch_hash.toString("hex")}` !== envelope.payload.dispatchHash
    ) throw new Error("Dispatch status is unavailable");
    return this.signedResponse(transaction, envelope.payload.dispatchHash);
  }

  async accept(args: {
    dispatch: SignedEnvelope<StandardRailDispatchV2, 2>;
    quote: SignedEnvelope<QuoteV1>;
    request: Record<string, unknown>;
    evidenceBundle: StandardEvidenceBundleV2;
  }) {
    await this.verifyDispatch(args.dispatch, args.request, true);
    const dispatch = args.dispatch.payload;
    const dispatchHash = canonicalHash(args.dispatch);
    const existing = await findTransaction(dispatch.gatewayAudience, dispatch.orderId);
    if (existing) {
      if (`0x${existing.dispatch_hash.toString("hex")}` !== dispatchHash) {
        throw new Error("Changed dispatch replay rejected");
      }
      return this.signedResponse(existing, dispatchHash);
    }

    const outcome = [...this.config.outcomes.values()].find((candidate) =>
      candidate.listingManifestHash === dispatch.listingManifestHash
      && candidate.providerOfferHash === dispatch.providerOfferHash);
    if (!outcome) throw new Error("Dispatch references an unknown outcome");
    this.assertDispatchIsCurrent(args.dispatch, outcome);
    this.assertOutcomeBinding(dispatch, outcome);
    await this.verifyQuote(args.quote, dispatch, outcome);
    if (dispatch.grossAmount !== outcome.fixedGrossAmount) {
      throw new Error("Dispatch price differs from the fixed provider offer");
    }
    const validate = this.validators.get(outcome.outcomeId);
    if (!validate) throw new Error("Provider request validator is unavailable");
    validateProviderRequest(validate, args.request);

    const service = getService(outcome.serviceSlug);
    const skill = getSkill(outcome.serviceSlug, outcome.skillId);
    if (!service || !skill || skill.fixedPriceAtomic !== outcome.fixedGrossAmount) {
      throw new Error("Outcome does not match an installed service skill");
    }

    const verified = await this.evidence.verify({
      dispatch,
      quote: args.quote,
      outcome,
      bundle: args.evidenceBundle,
    });
    for (const participant of [
      dispatch.payer,
      this.config.providerAuthorityKey,
      this.config.terminalAttestationKey,
      outcome.providerPayee,
      outcome.daskiCommissionReceiver,
      ...outcome.providerControlledWallets,
    ]) await this.evidence.assertNotSanctioned(participant);
    await admitStandardEvidence(
      dispatch.orderId,
      args.evidenceBundle,
      verified.authorizationKey,
    );

    const claimed = await claimTransaction({
      gatewayAudience: dispatch.gatewayAudience,
      orderId: dispatch.orderId,
      dispatchNonce: dispatch.dispatchNonce,
      dispatchHash,
      requestHash: dispatch.canonicalProviderRequestHash,
      payer: dispatch.payer,
      serviceSlug: outcome.serviceSlug,
      skillId: outcome.skillId,
      listingManifestHash: dispatch.listingManifestHash,
      maxOpenOrders: outcome.maxOpenOrders,
    });
    if (!claimed.fresh) return this.signedResponse(claimed.transaction, dispatchHash);

    let result: ServiceResult;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), MAX_EXECUTION_MS);
      timeout.unref();
      try {
        result = await Promise.race([
          getAdapter(outcome.serviceSlug).execute({
            taskId: claimed.transaction.id,
            orderId: dispatch.orderId,
            payer: dispatch.payer,
            serviceSlug: outcome.serviceSlug,
            skillId: outcome.skillId,
            signal: controller.signal,
          }, args.request),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener(
              "abort",
              () => reject(new Error("service execution timed out")),
              { once: true },
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      validateServiceResult(result);
    } catch {
      result = {
        status: "failed",
        errorCode: "service_execution_failed",
        message: "The provider could not complete this request.",
      };
    }
    const completed = await completeTransaction(claimed.transaction.id, result);
    return this.signedResponse(completed, dispatchHash);
  }

  private async verifyDispatch(
    envelope: SignedEnvelope<StandardRailDispatchV2, 2>,
    request: Record<string, unknown>,
    allowExpired = false,
  ): Promise<void> {
    assertExactKeys(envelope, SIGNED_ENVELOPE_KEYS, "dispatch envelope");
    assertExactKeys(envelope.payload, STANDARD_DISPATCH_PAYLOAD_KEYS, "dispatch payload");
    const now = Math.floor(Date.now() / 1_000);
    if (
      envelope.artifactType !== "StandardRailDispatchV2"
      || envelope.schemaVersion !== 2
      || envelope.environment !== this.config.environment
      || envelope.chainId !== this.chainId
      || envelope.audience !== this.config.providerAudience
      || envelope.issuedAt > now + 30
      || (!allowExpired && (envelope.validBefore <= now || envelope.validBefore > now + 300))
    ) throw new Error("Dispatch envelope domain or lifetime is invalid");
    const recovered = await recoverMessageAddress({
      message: { raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>) },
      signature: envelope.signature,
    });
    if (getAddress(recovered) !== this.config.gatewayDispatchSigner) {
      throw new Error("Dispatch signature is invalid");
    }
    const dispatch = envelope.payload;
    const hashes = [
      dispatch.providerControlProfileHash, dispatch.dispatchNonce,
      dispatch.listingManifestHash, dispatch.orderKey, dispatch.serviceId,
      dispatch.outcomeSchemaUid, dispatch.providerOfferHash, dispatch.quoteHash,
      dispatch.canonicalRequestHash, dispatch.orderNonce, dispatch.buyerIdentityProofHash,
      dispatch.activeRailProfileHash, dispatch.facilitatorConfirmationHash,
      dispatch.settlementTxHash, dispatch.depositBlockHash, dispatch.depositEvidenceHash,
      dispatch.releaseTxHash, dispatch.releaseBlockHash, dispatch.releaseEvidenceHash,
      dispatch.canonicalProviderRequestHash,
    ];
    const unsigned = /^(0|[1-9]\d*)$/;
    const depositBlock = unsigned.test(dispatch.depositBlockNumber)
      ? BigInt(dispatch.depositBlockNumber) : -1n;
    const releaseBlock = unsigned.test(dispatch.releaseBlockNumber)
      ? BigInt(dispatch.releaseBlockNumber) : -1n;
    const releaseAfterDeposit = releaseBlock > depositBlock
      || (releaseBlock === depositBlock
        && dispatch.releaseTransactionIndex > dispatch.depositTransactionIndex)
      || (releaseBlock === depositBlock
        && dispatch.releaseTransactionIndex === dispatch.depositTransactionIndex
        && dispatch.releaseLogIndex > dispatch.depositLogIndex);
    if (
      dispatch.environment !== this.config.environment
      || dispatch.chainId !== this.chainId
      || dispatch.gatewayAudience !== this.config.gatewayAudience
      || dispatch.providerAudience !== this.config.providerAudience
      || dispatch.reputationEligible !== true
      || getAddress(dispatch.reputationContract) !== this.config.reputationContract
      || dispatch.outcomeSchemaUid !== this.config.reputationOutcomeSchemaUid
      || dispatch.issuedAt !== envelope.issuedAt
      || dispatch.validBefore !== envelope.validBefore
      || dispatch.canonicalProviderRequestHash !== canonicalHash(request)
      || !/^0x[0-9a-fA-F]{40}$/.test(dispatch.payer)
      || !/^ord_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        .test(dispatch.orderId)
      || dispatch.orderKey !== keccak256(stringToHex(dispatch.orderId))
      || hashes.some((hash) => !/^0x[0-9a-fA-F]{64}$/.test(hash))
      || dispatch.facilitatorConfirmationHash.toLowerCase() === ZERO_BYTES32
      || depositBlock < 0n || releaseBlock < 0n
      || !Number.isSafeInteger(dispatch.depositTransactionIndex)
      || dispatch.depositTransactionIndex < 0
      || !Number.isSafeInteger(dispatch.depositLogIndex) || dispatch.depositLogIndex < 0
      || !Number.isSafeInteger(dispatch.releaseTransactionIndex)
      || dispatch.releaseTransactionIndex < 0
      || !Number.isSafeInteger(dispatch.releaseLogIndex) || dispatch.releaseLogIndex < 0
      || !/^[1-9]\d*$/.test(dispatch.releaseSequence)
      || BigInt(dispatch.releaseSequence) >= 1n << 64n
      || !releaseAfterDeposit
      || (depositBlock === releaseBlock
        && dispatch.depositBlockHash.toLowerCase() !== dispatch.releaseBlockHash.toLowerCase())
      || (depositBlock === releaseBlock
        && dispatch.depositTransactionIndex === dispatch.releaseTransactionIndex
        && dispatch.settlementTxHash.toLowerCase() !== dispatch.releaseTxHash.toLowerCase())
      || !/^[1-9]\d*$/.test(dispatch.grossAmount)
      || !/^[1-9]\d*$/.test(dispatch.providerNetAmount)
      || !/^[1-9]\d*$/.test(dispatch.daskiCommissionAmount)
      || BigInt(dispatch.providerNetAmount) + BigInt(dispatch.daskiCommissionAmount)
        !== BigInt(dispatch.grossAmount)
      || !Number.isSafeInteger(dispatch.dispatchDeadlineSeconds)
      || dispatch.dispatchDeadlineSeconds < 30
      || !Number.isSafeInteger(dispatch.issuedAt)
      || !Number.isSafeInteger(dispatch.validBefore)
    ) throw new Error("Dispatch payload binding is invalid");
  }

  private assertDispatchIsCurrent(
    envelope: SignedEnvelope<StandardRailDispatchV2, 2>,
    outcome: ProviderOutcomeConfig,
  ): void {
    const now = Math.floor(Date.now() / 1_000);
    if (
      envelope.validBefore <= now
      || envelope.payload.dispatchDeadlineSeconds !== outcome.dispatchDeadlineSeconds
      || envelope.validBefore !== envelope.issuedAt + outcome.dispatchDeadlineSeconds
    ) throw new Error("Dispatch lifetime is invalid for a new claim");
  }

  private assertOutcomeBinding(
    dispatch: StandardRailDispatchV2,
    outcome: ProviderOutcomeConfig,
  ): void {
    if (
      outcome.providerControlProfileHash !== dispatch.providerControlProfileHash
      || outcome.serviceId !== dispatch.serviceId
      || outcome.activeRailProfileHash !== dispatch.activeRailProfileHash
      || dispatch.buyerIdentityProofHash.toLowerCase() !== ZERO_BYTES32
      || outcome.bindingProfile !== dispatch.bindingProfile
    ) throw new Error("Dispatch conflicts with provider outcome policy");
    const forbidden = [
      this.config.providerAuthorityKey,
      this.config.terminalAttestationKey,
      outcome.providerPayee,
      outcome.daskiCommissionReceiver,
      outcome.splitter,
      ...outcome.providerControlledWallets,
    ].map((address) => getAddress(address).toLowerCase());
    if (forbidden.includes(getAddress(dispatch.payer).toLowerCase())) {
      throw new Error("Provider self-purchase is forbidden");
    }
  }

  private async verifyQuote(
    envelope: SignedEnvelope<QuoteV1>,
    dispatch: StandardRailDispatchV2,
    outcome: ProviderOutcomeConfig,
  ): Promise<void> {
    assertExactKeys(envelope, SIGNED_ENVELOPE_KEYS, "quote envelope");
    assertExactKeys(envelope.payload, [
      "listingManifestHash", "providerOfferHash", "providerQuoteHash",
      "canonicalRequestHash", "grossAmount", "token", "splitter", "orderNonce",
      "issuedAt", "validBefore",
    ], "quote payload");
    const now = Math.floor(Date.now() / 1_000);
    if (
      envelope.artifactType !== "QuoteV1"
      || envelope.schemaVersion !== 1
      || envelope.environment !== this.config.environment
      || envelope.chainId !== this.chainId
      || envelope.audience !== this.config.gatewayAudience
      || envelope.issuedAt !== envelope.payload.issuedAt
      || envelope.validBefore !== envelope.payload.validBefore
      || envelope.issuedAt > now + 30
      || envelope.validBefore <= envelope.issuedAt
      || canonicalHash(envelope) !== dispatch.quoteHash
    ) throw new Error("Quote envelope domain or lifetime is invalid");
    const recovered = await recoverMessageAddress({
      message: { raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>) },
      signature: envelope.signature,
    });
    if (getAddress(recovered) !== this.config.gatewayQuoteSigner) {
      throw new Error("Quote signature is invalid");
    }
    const quote = envelope.payload;
    if (
      quote.listingManifestHash !== dispatch.listingManifestHash
      || quote.providerOfferHash !== dispatch.providerOfferHash
      || quote.providerQuoteHash.toLowerCase() !== ZERO_BYTES32
      || quote.canonicalRequestHash !== dispatch.canonicalRequestHash
      || quote.grossAmount !== dispatch.grossAmount
      || getAddress(quote.token) !== getAddress(outcome.token)
      || getAddress(quote.splitter) !== getAddress(outcome.splitter)
      || quote.orderNonce !== dispatch.orderNonce
    ) throw new Error("Quote does not bind the dispatched order");
    assertFixedQuotePolicy(outcome);
    assertDispatchWithinQuoteSettlementWindow(dispatch, envelope, outcome);
  }

  private async signedResponse(transaction: ProviderTransaction, dispatchHash: Hex) {
    const summary = {
      taskId: transaction.id,
      dispatchHash,
      state: transaction.state,
    };
    const signature = await privateKeyToAccount(
      this.config.providerAuthorityPrivateKey,
    ).signMessage({ message: { raw: canonicalHash(summary) } });
    if (transaction.state === "executing") return { ...summary, signature };
    if (!transaction.completed_at || !transaction.result) {
      throw new Error("Terminal transaction result is incomplete");
    }
    const terminalPayload = {
      taskId: transaction.id,
      dispatchHash,
      state: transaction.state,
      resultHash: canonicalHash(transaction.result),
      completedAt: Math.floor(transaction.completed_at.getTime() / 1_000),
    };
    return {
      ...summary,
      result: transaction.result,
      signature,
      terminalAttestation: {
        payload: terminalPayload,
        signature: await privateKeyToAccount(
          this.config.terminalAttestationPrivateKey,
        ).signMessage({ message: { raw: canonicalHash(terminalPayload) } }),
      },
    };
  }
}

function validateServiceResult(result: ServiceResult): void {
  if (!result || (result.status !== "completed" && result.status !== "failed")) {
    throw new Error("Adapter must return a terminal result");
  }
  if (
    result.status === "failed"
    && !/^[a-z][a-z0-9_]{1,63}$/.test(result.errorCode)
  ) throw new Error("Adapter failure code is invalid");
  if (result.status === "completed") {
    if ((result.artifacts?.length ?? 0) > 20) throw new Error("Too many artifacts");
    for (const artifact of result.artifacts ?? []) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(artifact.name)) {
        throw new Error("Artifact name is invalid");
      }
      if (artifact.url) {
        const url = new URL(artifact.url);
        if (url.protocol !== "https:" || url.username || url.password) {
          throw new Error("Artifact URL must be credential-free HTTPS");
        }
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESULT_BYTES) {
    throw new Error("Adapter result is too large");
  }
}

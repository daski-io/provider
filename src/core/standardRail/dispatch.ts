import type { ValidateFunction } from "ajv";
import type { Chain, Hex } from "viem";
import { providerReady } from "../health.js";
import { logWarn } from "../logger.js";
import { getAdapter, getService, getSkill } from "../serviceRegistry/registry.js";
import { assertExactKeys, canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { admitDispatch, currentClaim, persistSynchronousResult } from "./dispatchAdmission.js";
import {
  DispatchAmbiguousError,
  DispatchRejectedError,
  withDispatchRejection,
} from "./dispatchErrors.js";
import {
  listingOf,
  providerListingSigner,
  signDispatchSnapshot,
  type DispatchSnapshot,
  type ListingSigner,
  type ProviderResponseSigner,
} from "./dispatchResponse.js";
import { answerDispatchStatus } from "./dispatchStatus.js";
import {
  assertDispatchIsCurrent,
  assertDispatchPayloadBound,
  assertOutcomeBinding,
  authenticateDispatchEnvelope,
} from "./dispatchVerification.js";
import { ProviderEvidenceVerifier } from "./evidence.js";
import { admitStandardEvidence } from "./evidenceAdmissions.js";
import { assertProviderQuoteBinding, verifyQuoteEnvelope } from "./quoteBinding.js";
import { loadProviderQuote } from "./quoteStore.js";
import { compileProviderSchema, validateProviderRequest } from "./schema.js";
import type { ResultContract } from "./serviceResult.js";
import { executeSynchronously } from "./syncExecution.js";
import { holdSyncLease, renewSyncLease, SYNC_LEASE, type SyncLeaseTiming } from "./syncLease.js";
import { dispatchHashOf, type ProviderTransaction } from "./transactionStore.js";
import type {
  ProviderOutcomeConfig,
  QuoteV1,
  SignedEnvelope,
  StandardEvidenceBundleV2,
  StandardRailDispatchV2,
} from "./types.js";

interface DispatchRequest {
  dispatch: SignedEnvelope<StandardRailDispatchV2, 2>;
  quote: SignedEnvelope<QuoteV1>;
  request: Record<string, unknown>;
  evidenceBundle: StandardEvidenceBundleV2;
}

export interface DispatchDependencies {
  evidence?: Pick<ProviderEvidenceVerifier, "verify" | "assertNotSanctioned">;
  /** Pre-admission product readiness for the legacy synchronous mode. */
  ready?: () => Promise<boolean>;
  /** One signer for every listing version; tests replace the configured keys. */
  signer?: ProviderResponseSigner;
  /** Execution lease timing; tests shorten it. */
  lease?: SyncLeaseTiming;
}

function parseDispatchRequest(body: unknown): DispatchRequest {
  try {
    assertExactKeys(body, ["dispatch", "quote", "request", "evidenceBundle"], "dispatch request");
  } catch {
    throw new DispatchRejectedError("validator", false);
  }
  const parts = body as Record<string, unknown>;
  for (const key of ["dispatch", "quote", "request", "evidenceBundle"]) {
    const value = parts[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new DispatchRejectedError("validator", false);
    }
  }
  return parts as unknown as DispatchRequest;
}

export class StandardDispatchService {
  private readonly evidence: Pick<ProviderEvidenceVerifier, "verify" | "assertNotSanctioned">;
  private readonly ready: () => Promise<boolean>;
  private readonly signers: ListingSigner;
  private readonly lease: SyncLeaseTiming;
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly resultValidators = new Map<string, ValidateFunction>();

  constructor(
    private readonly config: ProviderStandardRailConfig,
    chain: Chain,
    private readonly chainId: number,
    dependencies: DispatchDependencies = {},
  ) {
    this.evidence = dependencies.evidence ?? new ProviderEvidenceVerifier(config, chain);
    this.ready = dependencies.ready ?? providerReady;
    const injected = dependencies.signer;
    this.signers = injected ? () => injected : providerListingSigner(config);
    this.lease = dependencies.lease ?? SYNC_LEASE;
    // Every installed version, superseded ones included, keeps the request
    // and result contracts it was admitted with.
    for (const outcome of config.servicing.values()) {
      this.validators.set(
        outcome.listingManifestHash,
        compileProviderSchema(outcome.requestSchema as unknown as Record<string, unknown>),
      );
      this.resultValidators.set(outcome.listingManifestHash, compileProviderSchema(outcome.resultSchema));
    }
  }

  status(body: unknown): Promise<DispatchSnapshot> {
    return answerDispatchStatus(body, {
      config: this.config,
      chainId: this.chainId,
      signers: this.signers,
    });
  }

  /**
   * Admit and execute a funded dispatch. Definite refusals are thrown only
   * before any claim can exist for the order. Once a claim exists, or its
   * commit is uncertain, the answer is the signed snapshot or ambiguity.
   */
  async accept(body: unknown): Promise<DispatchSnapshot> {
    const parts = parseDispatchRequest(body);
    await authenticateDispatchEnvelope(parts.dispatch, this.config, this.chainId);
    const dispatch = parts.dispatch.payload;
    const dispatchHash = canonicalHash(parts.dispatch);
    const existing = await currentClaim(dispatch.gatewayAudience, dispatch.orderId);
    if (existing) return this.replay(existing, dispatchHash);
    let outcome: ProviderOutcomeConfig;
    let contract: ResultContract;
    let claimed: { transaction: ProviderTransaction; fresh: boolean };
    try {
      outcome = await this.verifyNewDispatch(parts);
      contract = this.resultContract(outcome);
      claimed = await admitDispatch({
        gatewayAudience: dispatch.gatewayAudience,
        orderId: dispatch.orderId,
        dispatchNonce: dispatch.dispatchNonce,
        dispatchHash,
        requestHash: dispatch.canonicalProviderRequestHash,
        payer: dispatch.payer,
        serviceSlug: outcome.serviceSlug,
        skillId: outcome.skillId,
        listingManifestHash: dispatch.listingManifestHash,
        dispatchValidBefore: parts.dispatch.validBefore,
        providerQuoteHash: parts.quote.payload.providerQuoteHash,
        leaseSeconds: this.lease.leaseSeconds,
      });
    } catch (error) {
      if (!(error instanceof DispatchRejectedError)) throw error;
      // Refuse only while an authoritative read still shows no claim: a
      // concurrent delivery of the same order may have been admitted.
      const raced = await currentClaim(dispatch.gatewayAudience, dispatch.orderId);
      if (raced) return this.replay(raced, dispatchHash);
      throw error;
    }
    if (!claimed.fresh) return this.replay(claimed.transaction, dispatchHash);
    const leaseToken = claimed.transaction.execution_lease_token;
    if (!leaseToken) throw new DispatchAmbiguousError("Admitted claim carries no execution lease");
    // The claim's expiry was computed when its transaction began, which can be
    // long before its COMMIT (a wait behind a concurrent claim, a slow commit).
    // Extend it, fenced, before the product call: a lease that already expired
    // may be failed by any process, so the call is never started under it.
    const held = await renewSyncLease(claimed.transaction.id, leaseToken, this.lease.leaseSeconds)
      .catch(() => false);
    if (!held) throw new DispatchAmbiguousError("Admitted claim's lease expired before execution started");
    // The lease is renewed until the result is persisted; a lost lease ends
    // the attempt without a write and the answer stays ambiguous.
    const lease = holdSyncLease(claimed.transaction.id, leaseToken, this.lease);
    try {
      const result = await executeSynchronously(getAdapter(outcome.serviceSlug), {
        taskId: claimed.transaction.id,
        orderId: dispatch.orderId,
        payer: dispatch.payer,
        serviceSlug: outcome.serviceSlug,
        skillId: outcome.skillId,
      }, parts.request, contract, lease.signal);
      if (lease.signal.aborted) throw new DispatchAmbiguousError("Synchronous execution lease was lost");
      return await this.snapshot(
        await persistSynchronousResult(claimed.transaction.id, leaseToken, result),
        dispatchHash,
      );
    } catch (error) {
      if (error instanceof DispatchAmbiguousError) throw error;
      throw new DispatchAmbiguousError("Admitted dispatch could not be answered", error);
    } finally {
      lease.stop();
    }
  }

  /** The admitted result schema and reviewed failure codes, resolved before admission. */
  private resultContract(outcome: ProviderOutcomeConfig): ResultContract {
    const validate = this.resultValidators.get(outcome.listingManifestHash);
    const service = getService(outcome.serviceSlug);
    if (!validate || !service) throw new DispatchRejectedError("outcome_policy");
    return { validate, failureCodes: new Set(service.failureCodes ?? []) };
  }

  /** An exact authenticated replay returns its claim, even after expiry; nothing replaces it. */
  private replay(existing: ProviderTransaction, dispatchHash: Hex): Promise<DispatchSnapshot> {
    if (dispatchHashOf(existing) !== dispatchHash) {
      logWarn("Different dispatch envelope for an admitted order was not admitted", {
        orderId: existing.order_id,
        taskId: existing.id,
      });
      throw new DispatchAmbiguousError("A different envelope cannot replace an admitted dispatch");
    }
    return this.snapshot(existing, dispatchHash);
  }

  private async snapshot(row: ProviderTransaction, dispatchHash: Hex): Promise<DispatchSnapshot> {
    try {
      return await signDispatchSnapshot(row, dispatchHash, this.signers(listingOf(row)));
    } catch (error) {
      throw new DispatchAmbiguousError("Dispatch snapshot could not be signed", error);
    }
  }

  /** Every check before admission; any failure here is a definite refusal. */
  private async verifyNewDispatch(parts: DispatchRequest): Promise<ProviderOutcomeConfig> {
    const dispatch = parts.dispatch.payload;
    try {
      assertDispatchPayloadBound(parts.dispatch, parts.request, this.config, this.chainId);
      // The funded order's own listing version, even if a newer one now takes
      // new sales: it is served with the definition it was paid under.
      const outcome = this.config.servicing.get(dispatch.listingManifestHash);
      if (!outcome || outcome.providerOfferHash !== dispatch.providerOfferHash) {
        throw new DispatchRejectedError("outcome_policy");
      }
      assertDispatchIsCurrent(parts.dispatch, outcome);
      assertOutcomeBinding(dispatch, outcome, this.config);
      await verifyQuoteEnvelope(parts.quote, dispatch, outcome, this.config, this.chainId);
      const providerQuote = await withDispatchRejection(
        "service_unavailable",
        () => loadProviderQuote(parts.quote.payload.providerQuoteHash),
      );
      assertProviderQuoteBinding(providerQuote, parts.quote, dispatch, outcome);
      const validate = this.validators.get(outcome.listingManifestHash);
      if (!validate) throw new DispatchRejectedError("validator");
      await withDispatchRejection("validator", () => validateProviderRequest(validate, parts.request));
      // The handler must be installed; only a head must also match the
      // build's current price (a superseded version keeps its admitted one).
      const skill = getSkill(outcome.serviceSlug, outcome.skillId);
      const head = this.config.outcomes.get(outcome.outcomeId) === outcome;
      if (
        !getService(outcome.serviceSlug) || !skill
        || (head && skill.fixedPriceAtomic !== outcome.fixedGrossAmount)
      ) throw new DispatchRejectedError("outcome_policy");
      // Synchronous execution during an outage would sign a terminal failure;
      // refusing before admission lets the gateway retry a fresh envelope.
      if (!(await this.ready().catch(() => false))) {
        throw new DispatchRejectedError("service_unavailable");
      }
      const verified = await withDispatchRejection("evidence", () => this.evidence.verify({
        dispatch,
        quote: parts.quote,
        outcome,
        bundle: parts.evidenceBundle,
      }));
      for (const participant of [
        dispatch.payer, this.config.providerAuthorityKey, this.config.terminalAttestationKey,
        outcome.providerPayee, outcome.daskiCommissionReceiver, ...outcome.providerControlledWallets,
      ]) await withDispatchRejection("evidence", () => this.evidence.assertNotSanctioned(participant));
      await withDispatchRejection("evidence", () => admitStandardEvidence(
        dispatch.orderId,
        parts.evidenceBundle,
        verified.authorizationKey,
      ));
      return outcome;
    } catch (error) {
      if (error instanceof DispatchRejectedError) throw error;
      throw new DispatchRejectedError("validator");
    }
  }
}

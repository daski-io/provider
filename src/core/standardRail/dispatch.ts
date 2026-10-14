import type { ValidateFunction } from "ajv";
import type { Chain, Hex } from "viem";
import { pool } from "../db/pool.js";
import {
  externalJobAdmissionBlocker,
  insertExternalJob,
  planExternalJob,
  type ExternalJobAdmission,
} from "../externalJobs/admission.js";
import { defaultExternalJobRuntime, type ExternalJobRuntime } from "../externalJobs/runtime.js";
import { providerReady } from "../health.js";
import { logWarn } from "../logger.js";
import { getService, getSkill } from "../serviceRegistry/registry.js";
import type { ExternalJobAdapter } from "../serviceRegistry/types.js";
import { assertExactKeys, canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { admitDispatch, currentClaim } from "./dispatchAdmission.js";
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
import { executeAdmittedSyncClaim } from "./syncDispatch.js";
import { SYNC_LEASE, type SyncLeaseTiming } from "./syncLease.js";
import {
  dispatchHashOf,
  getTransaction,
  type ClaimExecution,
  type ProviderTransaction,
} from "./transactionStore.js";
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
  /** This process's external-job runtime: key ring, worker wake-up. */
  externalJobs?: ExternalJobRuntime;
}

/** How a new claim executes, decided before it is admitted. */
type AdmissionPlan =
  | { kind: "sync"; contract: ResultContract }
  | { kind: "external-job"; job: ExternalJobAdmission };

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
  private readonly externalJobs: ExternalJobRuntime;
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
    this.externalJobs = dependencies.externalJobs ?? defaultExternalJobRuntime(config);
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
   * Admit a funded dispatch, then execute a synchronous one or leave an
   * external job queued for the worker. Definite refusals are thrown only
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
    let verified: { outcome: ProviderOutcomeConfig; plan: AdmissionPlan };
    let claimed: { transaction: ProviderTransaction; fresh: boolean };
    try {
      verified = await this.verifyNewDispatch(parts);
      claimed = await admitDispatch({
        gatewayAudience: dispatch.gatewayAudience,
        orderId: dispatch.orderId,
        dispatchNonce: dispatch.dispatchNonce,
        dispatchHash,
        requestHash: dispatch.canonicalProviderRequestHash,
        payer: dispatch.payer,
        serviceSlug: verified.outcome.serviceSlug,
        skillId: verified.outcome.skillId,
        listingManifestHash: dispatch.listingManifestHash,
        dispatchValidBefore: parts.dispatch.validBefore,
        providerQuoteHash: parts.quote.payload.providerQuoteHash,
        execution: this.claimExecution(verified.plan),
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
    if (verified.plan.kind === "external-job") return this.admittedJob(claimed.transaction, dispatchHash);
    return this.snapshot(await executeAdmittedSyncClaim({
      claim: claimed.transaction,
      context: {
        taskId: claimed.transaction.id,
        orderId: dispatch.orderId,
        payer: dispatch.payer,
        serviceSlug: verified.outcome.serviceSlug,
        skillId: verified.outcome.skillId,
      },
      input: parts.request,
      contract: verified.plan.contract,
      lease: this.lease,
    }), dispatchHash);
  }

  private claimExecution(plan: AdmissionPlan): ClaimExecution {
    if (plan.kind === "sync") return { kind: "sync", leaseSeconds: this.lease.leaseSeconds };
    const { job } = plan;
    return {
      kind: "external-job",
      insertJob: (client, taskId) => insertExternalJob(client, this.externalJobs.keys, taskId, job),
    };
  }

  /**
   * A durably admitted job: the answer acknowledges acceptance, `submitted`,
   * or a later state the worker has already persisted. Nothing here calls
   * the product; the worker starts the job.
   */
  private async admittedJob(claim: ProviderTransaction, dispatchHash: Hex): Promise<DispatchSnapshot> {
    this.externalJobs.wake();
    let current: ProviderTransaction | null;
    try {
      current = await getTransaction(claim.id);
    } catch (error) {
      throw new DispatchAmbiguousError("Admitted external job could not be read", error);
    }
    if (!current) throw new DispatchAmbiguousError("Admitted external job could not be read");
    return this.snapshot(current, dispatchHash);
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

  /**
   * An external job is admitted only while async admission is on and a key
   * can seal its input; product readiness is not consulted (the worker
   * waits for the product), and its stable idempotency key is fixed here.
   */
  private async externalJobPlan(
    adapter: ExternalJobAdapter,
    outcome: ProviderOutcomeConfig,
    dispatch: StandardRailDispatchV2,
    input: Record<string, unknown>,
  ): Promise<AdmissionPlan> {
    const blocker = await withDispatchRejection(
      "service_unavailable",
      () => externalJobAdmissionBlocker(this.externalJobs, pool),
    );
    if (blocker) {
      logWarn("External-job dispatch refused before admission", { diagnostic: blocker });
      throw new DispatchRejectedError("service_unavailable");
    }
    const job = planExternalJob({
      adapter,
      identity: {
        environment: this.config.environment,
        chainId: this.chainId,
        providerAgentId: this.externalJobs.providerAgentId,
        gatewayAudience: dispatch.gatewayAudience,
        orderId: dispatch.orderId,
        serviceSlug: outcome.serviceSlug,
        skillId: outcome.skillId,
      },
      fulfillmentSeconds: outcome.fulfillmentSeconds,
      input,
    });
    if (!job) throw new DispatchRejectedError("validator");
    return { kind: "external-job", job };
  }

  /** Every check before admission; any failure here is a definite refusal. */
  private async verifyNewDispatch(
    parts: DispatchRequest,
  ): Promise<{ outcome: ProviderOutcomeConfig; plan: AdmissionPlan }> {
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
      // The handler must be installed. The price is the version's admitted
      // one, which the provider quote binding has already enforced, even when
      // the build now sells at another price (contract drift).
      const service = getService(outcome.serviceSlug);
      if (!service || !getSkill(outcome.serviceSlug, outcome.skillId)) {
        throw new DispatchRejectedError("outcome_policy");
      }
      const contract = this.resultContract(outcome);
      let plan: AdmissionPlan;
      if (service.adapter.mode === "external-job") {
        plan = await this.externalJobPlan(service.adapter, outcome, dispatch, parts.request);
      } else {
        // Synchronous execution during an outage would sign a terminal
        // failure; refusing before admission lets the gateway retry.
        if (!(await this.ready().catch(() => false))) {
          throw new DispatchRejectedError("service_unavailable");
        }
        plan = { kind: "sync", contract };
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
      return { outcome, plan };
    } catch (error) {
      if (error instanceof DispatchRejectedError) throw error;
      throw new DispatchRejectedError("validator");
    }
  }
}

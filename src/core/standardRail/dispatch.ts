import type { ValidateFunction } from "ajv";
import type { Chain, Hex } from "viem";
import { insertExternalJob } from "../externalJobs/admission.js";
import { defaultExternalJobRuntime, type ExternalJobRuntime } from "../externalJobs/runtime.js";
import { providerReady } from "../health.js";
import { logWarn } from "../logger.js";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { admitDispatch, currentClaim } from "./dispatchAdmission.js";
import {
  parseDispatchRequest,
  verifyNewDispatch,
  type AdmissionPlan,
  type DispatchChecks,
} from "./dispatchChecks.js";
import { DispatchAmbiguousError, DispatchRejectedError } from "./dispatchErrors.js";
import {
  listingOf,
  providerListingSigner,
  signDispatchSnapshot,
  type DispatchSnapshot,
  type ListingSigner,
  type ProviderResponseSigner,
} from "./dispatchResponse.js";
import { answerDispatchStatus } from "./dispatchStatus.js";
import { authenticateDispatchEnvelope } from "./dispatchVerification.js";
import { ProviderEvidenceVerifier } from "./evidence.js";
import { ResultContracts } from "./resultContracts.js";
import { compileProviderSchema } from "./schema.js";
import { executeAdmittedSyncClaim } from "./syncDispatch.js";
import { SYNC_LEASE, type SyncLeaseTiming } from "./syncLease.js";
import {
  dispatchHashOf,
  getTransaction,
  type ClaimExecution,
  type ProviderTransaction,
} from "./transactionStore.js";
import type { ProviderOutcomeConfig } from "./types.js";

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

export class StandardDispatchService {
  private readonly signers: ListingSigner;
  private readonly lease: SyncLeaseTiming;
  private readonly checks: DispatchChecks;

  constructor(
    private readonly config: ProviderStandardRailConfig,
    chain: Chain,
    private readonly chainId: number,
    dependencies: DispatchDependencies = {},
  ) {
    const injected = dependencies.signer;
    this.signers = injected ? () => injected : providerListingSigner(config);
    this.lease = dependencies.lease ?? SYNC_LEASE;
    // Every installed version, superseded ones included, keeps the request
    // and result contracts it was admitted with.
    const validators = new Map<string, ValidateFunction>();
    for (const outcome of config.servicing.values()) {
      validators.set(
        outcome.listingManifestHash,
        compileProviderSchema(outcome.requestSchema as unknown as Record<string, unknown>),
      );
    }
    this.checks = {
      config,
      chainId,
      evidence: dependencies.evidence ?? new ProviderEvidenceVerifier(config, chain),
      ready: dependencies.ready ?? providerReady,
      externalJobs: dependencies.externalJobs ?? defaultExternalJobRuntime(config),
      validators,
      resultContracts: new ResultContracts(config),
    };
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
      verified = await verifyNewDispatch(this.checks, parts);
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
      insertJob: (client, taskId) => insertExternalJob(client, this.checks.externalJobs.keys, taskId, job),
    };
  }

  /**
   * A durably admitted job: the answer acknowledges acceptance, `submitted`,
   * or a later state the worker has already persisted. Nothing here calls
   * the product; the worker starts the job.
   */
  private async admittedJob(claim: ProviderTransaction, dispatchHash: Hex): Promise<DispatchSnapshot> {
    this.checks.externalJobs.wake();
    let current: ProviderTransaction | null;
    try {
      current = await getTransaction(claim.id);
    } catch (error) {
      throw new DispatchAmbiguousError("Admitted external job could not be read", error);
    }
    if (!current) throw new DispatchAmbiguousError("Admitted external job could not be read");
    return this.snapshot(current, dispatchHash);
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
}

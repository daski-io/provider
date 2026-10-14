import type { Hex } from "viem";
import { config as coreConfig, parsePayerAccountTypes } from "../config.js";
import { logError } from "../logger.js";
import type { ServiceResult } from "../serviceRegistry/types.js";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import {
  listingOf,
  operationsObservation,
  providerListingSigner,
  publicDispatchState,
  type ListingSigner,
  type OperationsObservation,
  type ProviderResponseSigner,
  type PublicDispatchState,
} from "./dispatchResponse.js";
import {
  LifecycleRefusal,
  LifecycleRejectedError,
  LifecycleUnavailableError,
} from "./lifecycleErrors.js";
import {
  assertReadCapability,
  isReadCapability,
  parseLifecycleCall,
  READ_ACTIONS,
  validateLifecycleCall,
  verifyLifecycleGrant,
  verifyPayerSignedRead,
  type LifecycleCall,
} from "./lifecycleRequest.js";
import { httpPayerRpcEndpoint } from "./payerRpc.js";
import type { PayerSignatureOptions } from "./payerSignature.js";
import { frozenArtifact, TerminalIntegrityError, terminalIdentity } from "./terminalIdentity.js";
import { findTransaction, type ProviderTransaction } from "./transactionStore.js";

/** The signed lifecycle answer: exact keys, `result` only for an artifact read. */
export interface LifecycleAnswer {
  orderId: string;
  taskId: string;
  state: PublicDispatchState;
  operations: OperationsObservation;
  result?: ServiceResult;
  terminalAttestation?: {
    payload: {
      orderId: string;
      taskId: string;
      state: "completed" | "failed";
      resultHash: Hex;
      completedAt: number;
    };
    signature: Hex;
  };
  signature: Hex;
}

export interface LifecycleDependencies {
  /** One signer for every listing version; tests replace the configured keys. */
  signer?: ProviderResponseSigner;
  payerSignatures?: Partial<PayerSignatureOptions>;
}

/**
 * Authenticated buyer lifecycle reads for lite (C01, C03, G02). Lite serves
 * `status` and `artifact`; `input`, `cancel` and `support` are answered with
 * the named `unsupported_action` refusal and cause no effect. Every answer
 * re-reads the task, stamps a fresh database-clock observation and is signed
 * afresh; a read never calls the product, enqueues work or writes.
 */
export class StandardLifecycleService {
  private readonly signers: ListingSigner;
  private readonly payerSignatures: PayerSignatureOptions;

  constructor(
    private readonly config: ProviderStandardRailConfig,
    private readonly chainId: number,
    dependencies: LifecycleDependencies = {},
  ) {
    const injected = dependencies.signer;
    this.signers = injected ? () => injected : providerListingSigner(config);
    this.payerSignatures = {
      accountTypes: parsePayerAccountTypes(coreConfig.PAYER_ACCOUNT_TYPES),
      verifyTimeoutMs: coreConfig.PAYER_SIGNATURE_VERIFY_TIMEOUT_MS,
      endpoints: coreConfig.CHAIN_MODE === "mock" ? [] : config.evidenceRpcUrls.map(httpPayerRpcEndpoint),
      ...dependencies.payerSignatures,
    };
  }

  /**
   * The grant first, then the call's shapes as the gateway's own call. A read
   * capability is held to its read-only rule; any other action is refused as
   * unsupported before a payer signature is checked or anything is looked up,
   * because lite performs none and nothing may happen. Reads verify the payer
   * signature, then read the task once.
   */
  async handle(body: unknown): Promise<LifecycleAnswer> {
    const unverified = parseLifecycleCall(body);
    const grant = await verifyLifecycleGrant(unverified, this.config, this.chainId);
    const call = validateLifecycleCall(unverified);
    const readCapability = isReadCapability(call.authorization);
    if (readCapability) assertReadCapability(call);
    if (!READ_ACTIONS.has(call.action)) throw new LifecycleRefusal("unsupported_action");
    if (!readCapability) {
      await verifyPayerSignedRead(call, grant, {
        config: this.config,
        chainId: this.chainId,
        payerSignatures: this.payerSignatures,
      });
    }
    const task = await this.task(call);
    return this.answer(task, call.action === "artifact");
  }

  /** The task the grant names, read once; unreadable is unavailable, never absent. */
  private async task(call: LifecycleCall): Promise<ProviderTransaction> {
    let task: ProviderTransaction | null;
    try {
      task = await findTransaction(this.config.gatewayAudience, call.orderId);
    } catch (error) {
      throw new LifecycleUnavailableError("Lifecycle task could not be read", error);
    }
    if (!task || task.id !== call.providerTaskId) throw new LifecycleRejectedError("unknown_task", true);
    if (task.payer.toLowerCase() !== call.payer.toLowerCase()) {
      throw new LifecycleRejectedError("binding", true);
    }
    return task;
  }

  private async answer(task: ProviderTransaction, artifact: boolean): Promise<LifecycleAnswer> {
    if (artifact && task.state !== "completed") throw new LifecycleRefusal("artifact_unavailable");
    try {
      // Signed with the keys the order's own listing version names.
      const signer = this.signers(listingOf(task));
      const state = publicDispatchState(task.state);
      const body: Omit<LifecycleAnswer, "signature"> = {
        orderId: task.order_id,
        taskId: task.id,
        state,
        operations: operationsObservation(task),
        ...(artifact ? { result: frozenArtifact(task) } : {}),
      };
      if (state !== "working") {
        const identity = terminalIdentity(task);
        const payload = {
          orderId: task.order_id,
          taskId: task.id,
          state: identity.state,
          resultHash: identity.resultHash,
          completedAt: identity.completedAt,
        };
        body.terminalAttestation = { payload, signature: await signer.terminal(canonicalHash(payload)) };
      }
      return { ...body, signature: await signer.authority(canonicalHash(body)) };
    } catch (error) {
      if (error instanceof TerminalIntegrityError) {
        logError("Stored terminal result does not prove its frozen identity", {
          taskId: task.id,
          diagnostic: "terminal_identity_unverifiable",
        });
      }
      throw new LifecycleUnavailableError("Lifecycle answer could not be signed", error);
    }
  }
}

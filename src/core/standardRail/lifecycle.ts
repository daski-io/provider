import type { Hex } from "viem";
import { config as coreConfig, parsePayerAccountTypes } from "../config.js";
import { logError } from "../logger.js";
import type { ServiceResult } from "../serviceRegistry/types.js";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import {
  operationsObservation,
  providerResponseSigner,
  publicDispatchState,
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
  parseLifecycleCall,
  READ_ACTIONS,
  verifyLifecycleAuthorization,
  verifyLifecycleGrant,
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
  private readonly signer: ProviderResponseSigner;
  private readonly payerSignatures: PayerSignatureOptions;

  constructor(
    private readonly config: ProviderStandardRailConfig,
    private readonly chainId: number,
    dependencies: LifecycleDependencies = {},
  ) {
    this.signer = dependencies.signer ?? providerResponseSigner(config);
    this.payerSignatures = {
      accountTypes: parsePayerAccountTypes(coreConfig.PAYER_ACCOUNT_TYPES),
      verifyTimeoutMs: coreConfig.PAYER_SIGNATURE_VERIFY_TIMEOUT_MS,
      endpoints: coreConfig.CHAIN_MODE === "mock" ? [] : config.evidenceRpcUrls.map(httpPayerRpcEndpoint),
      ...dependencies.payerSignatures,
    };
  }

  async handle(body: unknown): Promise<LifecycleAnswer> {
    const call = parseLifecycleCall(body);
    const grant = await verifyLifecycleGrant(call, this.config, this.chainId);
    await verifyLifecycleAuthorization(call, grant, {
      config: this.config,
      chainId: this.chainId,
      payerSignatures: this.payerSignatures,
    });
    if (!READ_ACTIONS.has(call.action)) throw new LifecycleRefusal("unsupported_action");
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
        body.terminalAttestation = { payload, signature: await this.signer.terminal(canonicalHash(payload)) };
      }
      return { ...body, signature: await this.signer.authority(canonicalHash(body)) };
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

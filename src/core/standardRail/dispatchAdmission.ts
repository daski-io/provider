import { logWarn } from "../logger.js";
import type { ServiceResult } from "../serviceRegistry/types.js";
import { canonicalHash } from "./canonical.js";
import { DispatchAmbiguousError, DispatchRejectedError } from "./dispatchErrors.js";
import {
  AdmissionExpiredError,
  AdmissionUncertainError,
  claimTransaction,
  completeTransaction,
  findTransaction,
  type ProviderTransaction,
} from "./transactionStore.js";

const RETRY_DELAYS_MS = [0, 250, 1_000];
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** The authoritative claim for an order. Unreadable is ambiguous, never absent. */
export async function currentClaim(
  gatewayAudience: string,
  orderId: string,
): Promise<ProviderTransaction | null> {
  try {
    return await findTransaction(gatewayAudience, orderId);
  } catch (error) {
    throw new DispatchAmbiguousError("Dispatch claim could not be read", error);
  }
}

/**
 * Claim a verified funded dispatch. A COMMIT whose outcome is unknown is
 * resolved only by reading the durable row (with a short bounded retry);
 * absence after it proves nothing, so that stays ambiguous. Every other
 * failure admitted nothing through this call and becomes a refusal, which
 * the caller re-checks against a concurrent claim before sending.
 */
export async function admitDispatch(
  claim: Parameters<typeof claimTransaction>[0],
): Promise<{ transaction: ProviderTransaction; fresh: boolean }> {
  try {
    return await claimTransaction(claim);
  } catch (error) {
    if (error instanceof AdmissionUncertainError) {
      for (const delay of RETRY_DELAYS_MS) {
        await sleep(delay);
        const current = await findTransaction(claim.gatewayAudience, claim.orderId)
          .catch(() => null);
        if (current) return { transaction: current, fresh: current.id === error.taskId };
      }
      throw new DispatchAmbiguousError("Dispatch admission commit outcome is unknown", error);
    }
    if (error instanceof AdmissionExpiredError) throw new DispatchRejectedError("envelope_lifetime");
    const code = (error as { code?: string }).code;
    throw new DispatchRejectedError(code === "23505" ? "validator" : "service_unavailable");
  }
}

/**
 * Persist an admitted synchronous result, retrying transient database
 * failures briefly. If another writer finalized the task first, that durable
 * state is served and the lost result is logged for reconciliation.
 */
export async function persistSynchronousResult(
  taskId: string,
  result: ServiceResult,
): Promise<ProviderTransaction> {
  let failure: unknown;
  for (const delay of RETRY_DELAYS_MS) {
    await sleep(delay);
    try {
      const stored = await completeTransaction(taskId, result);
      if (stored.result_hash?.toString("hex") !== canonicalHash(result).slice(2)) {
        logWarn("Synchronous result lost to a concurrent finalization", { taskId });
      }
      return stored;
    } catch (error) {
      failure = error;
    }
  }
  throw new DispatchAmbiguousError("Synchronous result could not be persisted", failure);
}

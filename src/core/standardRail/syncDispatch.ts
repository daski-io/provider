import { getSyncAdapter } from "../serviceRegistry/registry.js";
import type { TaskContext } from "../serviceRegistry/types.js";
import { persistSynchronousResult } from "./dispatchAdmission.js";
import { DispatchAmbiguousError } from "./dispatchErrors.js";
import type { ResultContract } from "./serviceResult.js";
import { executeSynchronously } from "./syncExecution.js";
import { holdSyncLease, renewSyncLease, type SyncLeaseTiming } from "./syncLease.js";
import type { ProviderTransaction } from "./transactionStore.js";

/**
 * Run a freshly admitted synchronous claim to its durable terminal state.
 * Every failure here follows an admission, so it is ambiguous, never a
 * refusal: the gateway status-polls the original dispatch hash.
 */
export async function executeAdmittedSyncClaim(args: {
  claim: ProviderTransaction;
  context: Omit<TaskContext, "signal">;
  input: Record<string, unknown>;
  contract: ResultContract;
  lease: SyncLeaseTiming;
}): Promise<ProviderTransaction> {
  const { claim } = args;
  const leaseToken = claim.execution_lease_token;
  if (!leaseToken) throw new DispatchAmbiguousError("Admitted claim carries no execution lease");
  // The claim's expiry was computed when its transaction began, which can be
  // long before its COMMIT (a wait behind a concurrent claim, a slow commit).
  // Extend it, fenced, before the product call: a lease that already expired
  // may be failed by any process, so the call is never started under it.
  const held = await renewSyncLease(claim.id, leaseToken, args.lease.leaseSeconds).catch(() => false);
  if (!held) throw new DispatchAmbiguousError("Admitted claim's lease expired before execution started");
  // The lease is renewed until the result is persisted; a lost lease ends
  // the attempt without a write and the answer stays ambiguous.
  const lease = holdSyncLease(claim.id, leaseToken, args.lease);
  try {
    const result = await executeSynchronously(
      getSyncAdapter(args.context.serviceSlug), args.context, args.input, args.contract, lease.signal,
    );
    if (lease.signal.aborted) throw new DispatchAmbiguousError("Synchronous execution lease was lost");
    return await persistSynchronousResult(claim.id, leaseToken, result);
  } catch (error) {
    if (error instanceof DispatchAmbiguousError) throw error;
    throw new DispatchAmbiguousError("Admitted dispatch could not be answered", error);
  } finally {
    lease.stop();
  }
}

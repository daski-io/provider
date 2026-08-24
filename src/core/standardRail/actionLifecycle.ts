import {
  getTransactionById,
  mergeTransactionMetadata,
  type TransactionRow,
} from "../db/queries/transactions.js";
import type { Queryable } from "../db/queryable.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import {
  applyTaskTransition,
  type DeferredTaskEmits,
} from "../engine/taskTransitions.js";

export type AssetActionCancellationReason =
  | "wallet_canceled"
  | "confirmation_expired";

/**
 * Keep a terminal destructive-action decision and its operator-facing
 * transaction in the same database transaction. The caller owns commit and
 * emits the deferred task notifications only after it succeeds.
 */
export async function cancelLinkedAssetActionTransaction(args: {
  db: Queryable;
  taskId: string;
  reason: AssetActionCancellationReason;
  deferred: DeferredTaskEmits;
}): Promise<TransactionRow> {
  const task = await getTransactionById(args.taskId, args.db);
  if (!task) throw new Error(`Transaction not found: ${args.taskId}`);
  if (task.status === "canceled") return task;
  if (task.status !== "working" && task.status !== "input-required") {
    throw new Error(
      `Asset action transaction ${args.taskId} cannot be canceled from ${task.status}`,
    );
  }

  const actionState = args.reason === "wallet_canceled" ? "canceled" : "expired";
  await mergeTransactionMetadata(args.taskId, {
    asset_action_state: actionState,
    asset_action_terminal_reason: args.reason,
  }, args.db);
  const transitioned = await applyTaskTransition(
    args.db,
    task,
    "canceled",
    {},
    args.deferred,
  );
  await recordMandatoryAudit(args.db, {
    transactionId: task.id,
    assetId: task.asset_id ?? undefined,
    serviceId: task.service_id,
    source: "system",
    type: `asset_action.${actionState}`,
    message: actionState === "canceled"
      ? "Staged asset action canceled by wallet authorization."
      : "Staged asset action expired before confirmation.",
    payload: {
      actionState,
      reason: args.reason,
      transactionStatus: "canceled",
    },
    actor: "system:standard-rail",
  });
  return transitioned;
}

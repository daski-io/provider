import type { TransactionRow } from "../../../db/queries/transactions.js";
import type { EmailAgentContext } from "./context.js";

export type EmailAuthorizationDecision =
  | { authorized: true }
  | {
      authorized: false;
      reason:
        | "authentication_required"
        | "authorization_expired"
        | "wrong_service"
        | "wrong_buyer"
        | "transaction_not_authorized"
        | "asset_not_authorized";
    };

/** One fail-closed policy for every sender → buyer → transaction → asset use. */
export function authorizeEmailTransaction(
  ctx: EmailAgentContext,
  transaction: TransactionRow,
  now = new Date(),
): EmailAuthorizationDecision {
  if (ctx.authorization.kind !== "authenticated") {
    return { authorized: false, reason: "authentication_required" };
  }
  if (ctx.authorization.expiresAt.getTime() <= now.getTime()) {
    return { authorized: false, reason: "authorization_expired" };
  }
  if (transaction.service_id !== ctx.serviceId) {
    return { authorized: false, reason: "wrong_service" };
  }
  if (transaction.customer_id !== ctx.authorization.customerId) {
    return { authorized: false, reason: "wrong_buyer" };
  }
  if (!ctx.authorization.transactionIds.includes(transaction.id)) {
    return { authorized: false, reason: "transaction_not_authorized" };
  }
  if (
    transaction.asset_id &&
    !ctx.authorization.assetIds.includes(transaction.asset_id)
  ) {
    return { authorized: false, reason: "asset_not_authorized" };
  }
  return { authorized: true };
}

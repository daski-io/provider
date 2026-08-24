import {
  getTransactionById,
  type TransactionRow,
} from "../../../db/queries/transactions.js";
import { setInboundEmailTransaction } from "../../../db/queries/emails.js";
import { emitEvent } from "../../../events/emitter.js";
import type { EmailAgentContext } from "./context.js";
import { authorizeEmailTransaction } from "./authorization.js";

// Shared helpers used by more than one Email Agent tool. Kept out of
// context.ts so that module stays type-only (the ServiceModule interface
// imports the EmailAgentTool type from it without pulling in db queries).

// Persist an authorized inbound→transaction link for escalation audit
// context. Returns the resolved transaction row, or null if the id doesn't
// exist, belongs to another service, or is outside the authorization.
export async function linkInboundToTransaction(
  ctx: EmailAgentContext,
  transactionId: string,
): Promise<TransactionRow | null> {
  const tx = await getTransactionById(transactionId);
  if (!tx) return null;
  if (!authorizeEmailTransaction(ctx, tx).authorized) return null;
  if (ctx.inbound.transaction_id === transactionId) return tx; // already linked
  await setInboundEmailTransaction(ctx.inbound.id, {
    transaction_id: tx.id,
    customer_id: tx.customer_id,
  });
  ctx.inbound.transaction_id = tx.id;
  ctx.inbound.customer_id = tx.customer_id;
  await emitEvent({
    serviceId: ctx.serviceId,
    transactionId: tx.id,
    source: "email",
    severity: "debug",
    type: "email.linked_transaction",
    message: `Inbound email linked to transaction ${tx.id.slice(0, 12)}…`,
    payload: { inboundId: ctx.inbound.id, transactionId: tx.id },
  });
  return tx;
}

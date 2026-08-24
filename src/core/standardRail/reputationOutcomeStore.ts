import type { Queryable } from "../db/queryable.js";
import type { TransactionRow, TransactionStatus } from "../db/queries/transactions.js";

const outcomes: Partial<Record<TransactionStatus, number>> = {
  completed: 0,
  failed: 1,
  canceled: 2,
};

export async function enqueueReputationOutcome(
  transaction: TransactionRow,
  db: Queryable,
): Promise<void> {
  const outcome = outcomes[transaction.status];
  if (
    outcome === undefined || !transaction.standard_order_id ||
    !transaction.standard_order_key
  ) return;
  await db.query(
    `INSERT INTO standard_reputation_outcomes(order_key,transaction_id,outcome,state)
     VALUES ($1,$2,$3,'pending')
     ON CONFLICT (order_key) DO UPDATE SET order_key=EXCLUDED.order_key
     WHERE standard_reputation_outcomes.transaction_id=EXCLUDED.transaction_id
       AND standard_reputation_outcomes.outcome=EXCLUDED.outcome`,
    [transaction.standard_order_key, transaction.id, outcome],
  );
}

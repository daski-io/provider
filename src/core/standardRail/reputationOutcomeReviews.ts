import { pool } from "../db/pool.js";
import { closeEscalation } from "../db/queries/escalations.js";
import { inTransaction, type Queryable } from "../db/queryable.js";
import { createHumanEscalation } from "../engine/escalation.js";

export const REPUTATION_OUTCOME_REVIEW_KIND = "reputation_outcome_recovery";
export const REPUTATION_OUTCOME_TARGET_TYPE = "standard_reputation_outcome";

export type ReputationOutcomeFailureClass =
  | "rpc_finality"
  | "balance_fee"
  | "nonce_conflict"
  | "contract_rejection"
  | "application_fault";

export interface ReputationOutcomeReviewRow {
  order_key: Buffer;
  transaction_id: string;
  outcome: number;
  provider_write_id: string | null;
  attempt_count: number;
  retry_once_used: boolean;
  last_error_class?: string | null;
}

const OPEN_REVIEW_STATES =
  "'pending','in_agent_review','awaiting_human','resolution_attention'";

const reasonCopy: Record<ReputationOutcomeFailureClass, string> = {
  rpc_finality: "The chain receipt or finality check could not be verified.",
  balance_fee: "The provider wallet could not cover or satisfy the network fee.",
  nonce_conflict: "The provider wallet transaction sequence conflicted with chain state.",
  contract_rejection: "The reputation contract rejected or could not verify the submission.",
  application_fault: "The provider could not safely determine the submission state.",
};

export function reputationOutcomeTargetId(orderKey: Buffer): string {
  return `0x${orderKey.toString("hex")}`;
}

function normalizedReason(value: string | null | undefined): ReputationOutcomeFailureClass {
  return value && Object.hasOwn(reasonCopy, value)
    ? value as ReputationOutcomeFailureClass
    : "application_fault";
}

function suggestedActions(
  row: ReputationOutcomeReviewRow,
  reason: ReputationOutcomeFailureClass,
): Array<{ label: string; value: string; effect: string }> {
  const orderKey = reputationOutcomeTargetId(row.order_key);
  if (row.provider_write_id) {
    return [{
      label: "Check submitted transaction",
      value: JSON.stringify({
        tool: "reconcile_reputation_outcome",
        arguments: { order_key: orderKey, reason_class: reason },
      }),
      effect:
        "Checks the exact saved blockchain write and does not create a replacement transaction.",
    }];
  }
  return [
    ...(!row.retry_once_used ? [{
      label: "Retry once",
      value: JSON.stringify({
        tool: "retry_reputation_outcome_once",
        arguments: { order_key: orderKey, reason_class: reason },
      }),
      effect: "Returns this report to automation for its one permitted additional attempt.",
    }] : []),
    {
      label: "Stop trying",
      value: JSON.stringify({
        tool: "abort_reputation_outcome",
        arguments: { order_key: orderKey, reason_class: reason },
      }),
      effect: "Records that this reputation report will remain unattested.",
    },
  ];
}

export async function surfaceReputationOutcomeReview(args: {
  row: ReputationOutcomeReviewRow;
  reason: ReputationOutcomeFailureClass;
  db?: Queryable;
}): Promise<void> {
  const orderKey = reputationOutcomeTargetId(args.row.order_key);
  await createHumanEscalation({
    source: "auto",
    transactionId: args.row.transaction_id,
    question: `Marketplace reputation update for transaction ${args.row.transaction_id} needs a decision.`,
    title: "Marketplace reputation update needs attention",
    summary:
      `Automatic publication stopped after ${args.row.attempt_count} attempt(s). `
      + `${reasonCopy[args.reason]} Choose a bound recovery action below.`,
    review: {
      kind: REPUTATION_OUTCOME_REVIEW_KIND,
      severity: args.reason === "balance_fee" || args.reason === "nonce_conflict"
        ? "critical"
        : "warning",
      dedupeKey: `reputation-outcome-recovery:${orderKey}`,
      target: { type: REPUTATION_OUTCOME_TARGET_TYPE, id: orderKey },
      whyHuman:
        `${reasonCopy[args.reason]} Automated retries stopped to prevent an ambiguous `
        + "or duplicate blockchain submission.",
      evidence: {
        version: 1,
        orderKey,
        transactionId: args.row.transaction_id,
        outcome: args.row.outcome,
        providerWriteId: args.row.provider_write_id,
        attemptCount: args.row.attempt_count,
        retryOnceUsed: args.row.retry_once_used,
        reason: args.reason,
      },
    },
    suggestedActions: suggestedActions(args.row, args.reason),
  }, args.db);
}

export interface ReputationReviewReconciliation {
  opened: number;
  closed: number;
}

export async function reconcileReputationOutcomeReviews(
  limit = 50,
): Promise<ReputationReviewReconciliation> {
  return inTransaction(pool, async (db) => {
    const resolved = await db.query<{ id: string; state: string }>(
      `SELECT e.id,o.state
         FROM escalations e
         JOIN standard_reputation_outcomes o
           ON lower(e.target_id) = '0x' || encode(o.order_key,'hex')
        WHERE e.review_kind = $1
          AND e.target_type = $2
          AND e.status IN (${OPEN_REVIEW_STATES})
          AND o.state <> 'operator_attention'
        ORDER BY e.created_at
        FOR UPDATE OF e SKIP LOCKED
        LIMIT $3`,
      [REPUTATION_OUTCOME_REVIEW_KIND, REPUTATION_OUTCOME_TARGET_TYPE, limit],
    );
    let closed = 0;
    for (const review of resolved.rows) {
      const result = await closeEscalation({
        id: review.id,
        status: "resolved",
        resolved_by: "system",
        response: review.state === "final"
          ? "Reputation report finalized on chain."
          : review.state === "aborted_unattested"
            ? "Reputation report was explicitly stopped."
            : "Reputation report returned to automated processing.",
      }, db);
      if (result) closed += 1;
    }

    const unsurfaced = await db.query<ReputationOutcomeReviewRow>(
      `SELECT o.order_key,o.transaction_id,o.outcome,o.provider_write_id,
              o.attempt_count,o.retry_once_used,o.last_error_class
         FROM standard_reputation_outcomes o
        WHERE o.state = 'operator_attention'
          AND NOT EXISTS (
            SELECT 1 FROM escalations e
             WHERE e.review_kind = $1
               AND e.target_type = $2
               AND lower(e.target_id) = '0x' || encode(o.order_key,'hex')
               AND e.status IN (${OPEN_REVIEW_STATES})
          )
        ORDER BY o.updated_at
        FOR UPDATE OF o SKIP LOCKED
        LIMIT $3`,
      [REPUTATION_OUTCOME_REVIEW_KIND, REPUTATION_OUTCOME_TARGET_TYPE, limit],
    );
    for (const row of unsurfaced.rows) {
      await surfaceReputationOutcomeReview({
        row,
        reason: normalizedReason(row.last_error_class),
        db,
      });
    }
    return { opened: unsurfaced.rows.length, closed };
  });
}

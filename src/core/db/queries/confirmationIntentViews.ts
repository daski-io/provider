import { pool } from "../pool.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PendingThreadIntent {
  id: string;
  threadId: string;
  actionName: string;
  targetType: string;
  targetId: string;
  expiresAt: Date;
}

export async function listPendingConfirmationIntentsForThreads(args: {
  threadIds: string[];
  operatorWallet: string;
  sessionId: string;
}): Promise<PendingThreadIntent[]> {
  if (args.threadIds.length === 0) return [];
  const result = await pool.query(
    `SELECT id, thread_id, action_name, target_type, target_id, expires_at
       FROM operator_confirmation_intents
      WHERE thread_id = ANY($1)
        AND operator_wallet = lower($2)
        AND session_id = $3
        AND approved_at IS NULL
        AND consumed_at IS NULL
        AND voided_at IS NULL
        AND expires_at > now()
      ORDER BY issued_at`,
    [args.threadIds, args.operatorWallet, args.sessionId],
  );
  return (result.rows as Array<{
    id: string;
    thread_id: string;
    action_name: string;
    target_type: string;
    target_id: string;
    expires_at: Date;
  }>).map((row) => ({
    id: row.id,
    threadId: row.thread_id,
    actionName: row.action_name,
    targetType: row.target_type,
    targetId: row.target_id,
    expiresAt: row.expires_at,
  }));
}

export interface ConfirmationIntentState {
  id: string;
  approvedAt: Date | null;
  consumedAt: Date | null;
  voidedAt: Date | null;
  expiresAt: Date;
  executionStatus:
    | "not_started"
    | "executing"
    | "succeeded"
    | "failed"
    | "outcome_unknown";
  executionErrorSummary: string | null;
}

export async function getConfirmationIntentStates(
  ids: string[],
): Promise<Map<string, ConfirmationIntentState>> {
  const valid = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
  const states = new Map<string, ConfirmationIntentState>();
  if (valid.length === 0) return states;
  const result = await pool.query(
    `SELECT id, approved_at, consumed_at, voided_at, expires_at,
            execution_status, execution_error_summary
       FROM operator_confirmation_intents
      WHERE id = ANY($1)`,
    [valid],
  );
  for (const row of result.rows as Array<{
    id: string;
    approved_at: Date | null;
    consumed_at: Date | null;
    voided_at: Date | null;
    expires_at: Date;
    execution_status: ConfirmationIntentState["executionStatus"];
    execution_error_summary: string | null;
  }>) {
    states.set(row.id, {
      id: row.id,
      approvedAt: row.approved_at,
      consumedAt: row.consumed_at,
      voidedAt: row.voided_at,
      expiresAt: row.expires_at,
      executionStatus: row.execution_status,
      executionErrorSummary: row.execution_error_summary,
    });
  }
  return states;
}

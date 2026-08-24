import { recordMandatoryAudit } from "../../events/emitter.js";
import { pool } from "../pool.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ConfirmationApprovalRow {
  thread_id: string;
  action_name: string;
  target_type: string;
  target_id: string;
}

export type ConfirmationApprovalResult =
  | {
      ok: true;
      threadId: string;
      actionName: string;
      targetType: string;
      targetId: string;
      newlyApproved: boolean;
    }
  | { ok: false };

function approvalResult(
  row: ConfirmationApprovalRow,
  newlyApproved: boolean,
): ConfirmationApprovalResult {
  return {
    ok: true,
    threadId: row.thread_id,
    actionName: row.action_name,
    targetType: row.target_type,
    targetId: row.target_id,
    newlyApproved,
  };
}

/**
 * Mark an intent approved only from the authenticated browser POST path. The
 * intent id is not a bearer: approval requires the WHERE clause to match the
 * intent's own operator wallet, SIWE session, and thread, so only the session
 * that previewed the action can approve it.
 */
export async function approveConfirmationIntent(args: {
  intentId: string;
  operatorWallet: string;
  sessionId: string;
  threadId: string;
}): Promise<ConfirmationApprovalResult> {
  if (!UUID_RE.test(args.intentId)) return { ok: false };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE operator_confirmation_intents
          SET approved_at = now(), approved_by = lower($2), approved_session_id = $3
        WHERE id = $1
          AND operator_wallet = lower($2)
          AND session_id = $3
          AND thread_id = $4
          AND approved_at IS NULL
          AND consumed_at IS NULL
          AND voided_at IS NULL
          AND expires_at > now()
        RETURNING thread_id, action_name, target_type, target_id`,
      [args.intentId, args.operatorWallet, args.sessionId, args.threadId],
    );
    const row = result.rows[0] as ConfirmationApprovalRow | undefined;
    if (row) {
      await recordMandatoryAudit(client, {
        source: "admin",
        type: "operator.confirmation_approved",
        actor: args.operatorWallet,
        message: `Approved confirmation for ${row.action_name}.`,
        payload: {
          action: row.action_name,
          targetType: row.target_type,
          targetId: row.target_id,
          threadId: row.thread_id,
        },
      });
      await client.query("COMMIT");
      return approvalResult(row, true);
    }
    const approved = await client.query(
      `SELECT thread_id, action_name, target_type, target_id
         FROM operator_confirmation_intents
        WHERE id = $1
          AND operator_wallet = lower($2)
          AND session_id = $3
          AND thread_id = $4
          AND approved_at IS NOT NULL
          AND approved_by = lower($2)
          AND approved_session_id = $3
          AND consumed_at IS NULL
          AND voided_at IS NULL
          AND expires_at > now()`,
      [args.intentId, args.operatorWallet, args.sessionId, args.threadId],
    );
    await client.query("COMMIT");
    const existing = approved.rows[0] as ConfirmationApprovalRow | undefined;
    return existing ? approvalResult(existing, false) : { ok: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

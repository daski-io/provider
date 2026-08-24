import { recordMandatoryAudit } from "../../events/emitter.js";
import { pool } from "../pool.js";
import {
  confirmationArgumentsDigest,
  type ConfirmationBinding,
  validateConfirmationBinding,
} from "./confirmationBinding.js";
import {
  revealPendingPayload,
  voidUnavailableConfirmationPayload,
} from "./confirmationPayload.js";

export interface ConsumedConfirmationIntent {
  id: string;
  payload: Record<string, unknown>;
}

export async function consumeApprovedConfirmationIntent(
  binding: ConfirmationBinding,
): Promise<ConsumedConfirmationIntent | null> {
  validateConfirmationBinding(binding);
  const argumentsHash = confirmationArgumentsDigest(binding.arguments);
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const selected = await client.query(
      `SELECT id, pending_payload_encrypted, action_name, target_type, target_id, thread_id
         FROM operator_confirmation_intents
        WHERE operator_wallet = lower($1)
          AND session_id = $2
          AND thread_id = $3
          AND origin_turn_id <> $4
          AND action_name = $5
          AND arguments_hash = $6
          AND target_type = $7
          AND target_id = $8
          AND approved_at IS NOT NULL
          AND approved_by = lower($1)
          AND approved_session_id = $2
          AND expires_at > now()
          AND consumed_at IS NULL
          AND voided_at IS NULL
        ORDER BY approved_at, issued_at
        LIMIT 1
        FOR UPDATE`,
      [
        binding.operatorWallet,
        binding.sessionId,
        binding.threadId,
        binding.turnId,
        binding.actionName,
        argumentsHash,
        binding.targetType,
        binding.targetId,
      ],
    );
    const row = selected.rows[0] as {
      id: string;
      pending_payload_encrypted: string | null;
      action_name: string;
      target_type: string;
      target_id: string;
      thread_id: string;
    } | undefined;
    if (!row) {
      await client.query("COMMIT");
      transactionOpen = false;
      return null;
    }
    let payload: Record<string, unknown>;
    try {
      payload = revealPendingPayload(row.id, row.pending_payload_encrypted);
    } catch (error) {
      await voidUnavailableConfirmationPayload(client, row, binding.operatorWallet);
      await client.query("COMMIT");
      transactionOpen = false;
      throw error;
    }
    const consumed = await client.query(
      `UPDATE operator_confirmation_intents
          SET consumed_at = now(), consumed_turn_id = $2,
              execution_status = 'executing',
              execution_started_at = now(),
              execution_finished_at = NULL,
              execution_error_code = NULL,
              execution_error_summary = NULL
        WHERE id = $1
          AND consumed_at IS NULL
          AND voided_at IS NULL`,
      [row.id, binding.turnId],
    );
    if ((consumed.rowCount ?? 0) !== 1) {
      throw new Error("confirmation intent changed while locked");
    }
    await recordMandatoryAudit(client, {
      source: "admin",
      type: "operator.confirmation_consumed",
      actor: binding.operatorWallet,
      message: `Consumed approved confirmation for ${binding.actionName}.`,
      payload: {
        action: binding.actionName,
        targetType: binding.targetType,
        targetId: binding.targetId,
        threadId: binding.threadId,
      },
    });
    await client.query("COMMIT");
    transactionOpen = false;
    return { id: row.id, payload };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

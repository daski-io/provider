import { randomUUID } from "node:crypto";
import { encryptString } from "../../chain/encryption.js";
import { recordMandatoryAudit } from "../../events/emitter.js";
import { pool } from "../pool.js";
import {
  confirmationArgumentsDigest,
  type ConfirmationBinding,
  validateConfirmationBinding,
} from "./confirmationBinding.js";
import { canonicalActionArguments } from "./confirmationCanonical.js";
import {
  pendingPayloadContext,
  revealPendingPayload,
  voidUnavailableConfirmationPayload,
} from "./confirmationPayload.js";

export const CONFIRMATION_INTENT_TTL_MS = 30 * 60 * 1000;

export interface IssuedConfirmationIntent {
  id: string;
  expiresAt: Date;
}

export async function createConfirmationIntent(
  binding: ConfirmationBinding,
  payload: Record<string, unknown> = {},
): Promise<IssuedConfirmationIntent> {
  validateConfirmationBinding(binding);
  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO operator_confirmation_intents
       (id, operator_wallet, session_id, thread_id, origin_turn_id,
        action_name, arguments_hash, target_type, target_id,
        pending_payload_encrypted, expires_at)
     VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, expires_at`,
    [
      id,
      binding.operatorWallet,
      binding.sessionId,
      binding.threadId,
      binding.turnId,
      binding.actionName,
      confirmationArgumentsDigest(binding.arguments),
      binding.targetType,
      binding.targetId,
      encryptString(canonicalActionArguments(payload), pendingPayloadContext(id)),
      new Date(Date.now() + CONFIRMATION_INTENT_TTL_MS),
    ],
  );
  const row = result.rows[0] as { id: string; expires_at: Date };
  return { id: row.id, expiresAt: row.expires_at };
}

export interface OpenConfirmationIntent {
  id: string;
  originTurnId: string;
  approvedAt: Date | null;
  expiresAt: Date;
  pendingPayload: Record<string, unknown>;
}

export async function findOpenConfirmationIntent(
  binding: ConfirmationBinding,
): Promise<OpenConfirmationIntent | null> {
  validateConfirmationBinding(binding);
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const result = await client.query(
      `SELECT id, origin_turn_id, approved_at, expires_at, pending_payload_encrypted,
              action_name, target_type, target_id, thread_id
         FROM operator_confirmation_intents
        WHERE operator_wallet = lower($1)
          AND session_id = $2
          AND thread_id = $3
          AND action_name = $4
          AND arguments_hash = $5
          AND target_type = $6
          AND target_id = $7
          AND consumed_at IS NULL
          AND voided_at IS NULL
          AND expires_at > now()
        ORDER BY issued_at DESC
        LIMIT 1
        FOR UPDATE`,
      [
        binding.operatorWallet,
        binding.sessionId,
        binding.threadId,
        binding.actionName,
        confirmationArgumentsDigest(binding.arguments),
        binding.targetType,
        binding.targetId,
      ],
    );
    const row = result.rows[0] as
      | {
          id: string;
          origin_turn_id: string;
          approved_at: Date | null;
          expires_at: Date;
          pending_payload_encrypted: string | null;
          action_name: string;
          target_type: string;
          target_id: string;
          thread_id: string;
        }
      | undefined;
    if (!row) {
      await client.query("COMMIT");
      transactionOpen = false;
      return null;
    }
    let pendingPayload: Record<string, unknown>;
    try {
      pendingPayload = revealPendingPayload(row.id, row.pending_payload_encrypted);
    } catch (error) {
      await voidUnavailableConfirmationPayload(client, row, binding.operatorWallet);
      await client.query("COMMIT");
      transactionOpen = false;
      throw error;
    }
    await client.query("COMMIT");
    transactionOpen = false;
    return {
      id: row.id,
      originTurnId: row.origin_turn_id,
      approvedAt: row.approved_at,
      expiresAt: row.expires_at,
      pendingPayload,
    };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function voidConfirmationIntent(
  intentId: string,
  actor: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE operator_confirmation_intents
          SET voided_at = now()
        WHERE id = $1
          AND approved_at IS NULL
          AND consumed_at IS NULL
          AND voided_at IS NULL
        RETURNING action_name, target_type, target_id, thread_id`,
      [intentId],
    );
    const row = result.rows[0] as
      | { action_name: string; target_type: string; target_id: string; thread_id: string }
      | undefined;
    if (row) {
      await recordMandatoryAudit(client, {
        source: "admin",
        type: "operator.confirmation_superseded",
        actor,
        message: `Superseded confirmation preview for ${row.action_name}.`,
        payload: {
          action: row.action_name,
          targetType: row.target_type,
          targetId: row.target_id,
          threadId: row.thread_id,
        },
      });
    }
    await client.query("COMMIT");
    return Boolean(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

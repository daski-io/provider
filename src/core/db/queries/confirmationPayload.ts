import { decryptString } from "../../chain/encryption.js";
import { recordMandatoryAudit } from "../../events/emitter.js";
import type { Queryable } from "../queryable.js";

export function pendingPayloadContext(id: string) {
  return {
    purpose: "operator-confirmation-payload",
    table: "operator_confirmation_intents",
    recordId: id,
    field: "pending_payload_encrypted",
    service: "core",
  } as const;
}

export class ConfirmationPayloadIntegrityError extends Error {
  constructor() {
    super("The approved action payload is unavailable.");
    this.name = "ConfirmationPayloadIntegrityError";
  }
}

export function revealPendingPayload(
  id: string,
  encrypted: unknown,
): Record<string, unknown> {
  try {
    if (typeof encrypted !== "string" || encrypted.length === 0) {
      throw new Error("missing ciphertext");
    }
    const value = JSON.parse(decryptString(encrypted, pendingPayloadContext(id))) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid payload shape");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new ConfirmationPayloadIntegrityError();
  }
}

export async function voidUnavailableConfirmationPayload(
  db: Queryable,
  row: {
    id: string;
    action_name: string;
    target_type: string;
    target_id: string;
    thread_id: string;
  },
  actor: string,
): Promise<void> {
  const result = await db.query(
    `UPDATE operator_confirmation_intents
        SET voided_at = now(),
            execution_status = 'failed',
            execution_finished_at = now(),
            execution_error_code = 'confirmation_payload_unavailable',
            execution_error_summary =
              'The approved action payload is unavailable and cannot be executed.'
      WHERE id = $1
        AND consumed_at IS NULL
        AND voided_at IS NULL`,
    [row.id],
  );
  if ((result.rowCount ?? 0) === 0) return;
  await recordMandatoryAudit(db, {
    source: "admin",
    type: "operator.confirmation_payload_unavailable",
    actor,
    message: `Voided confirmation for ${row.action_name} because its payload was unavailable.`,
    payload: {
      action: row.action_name,
      targetType: row.target_type,
      targetId: row.target_id,
      threadId: row.thread_id,
    },
  });
}

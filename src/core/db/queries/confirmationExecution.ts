import { redactSensitiveText } from "../../security/redaction.js";
import { pool } from "../pool.js";

export async function completeConfirmationExecution(intentId: string): Promise<void> {
  await pool.query(
    `UPDATE operator_confirmation_intents
        SET execution_status = 'succeeded',
            execution_finished_at = now(),
            execution_error_code = NULL,
            execution_error_summary = NULL
      WHERE id = $1 AND execution_status = 'executing'`,
    [intentId],
  );
}

export async function failConfirmationExecution(
  intentId: string,
  error: unknown,
): Promise<void> {
  const summary = redactSensitiveText(
    error instanceof Error ? error.message : String(error),
  ).replace(/\s+/g, " ").trim().slice(0, 512) || "The approved action failed.";
  const code = error instanceof Error && error.name
    ? error.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
    : "execution_failed";
  await pool.query(
    `UPDATE operator_confirmation_intents
        SET execution_status = 'failed',
            execution_finished_at = now(),
            execution_error_code = $2,
            execution_error_summary = $3
      WHERE id = $1 AND execution_status = 'executing'`,
    [intentId, code, summary],
  );
}

export async function classifyStaleConfirmationExecutions(): Promise<number> {
  const result = await pool.query(
    `UPDATE operator_confirmation_intents
        SET execution_status = 'outcome_unknown',
            execution_finished_at = now(),
            execution_error_code = 'execution_outcome_unproved',
            execution_error_summary =
              'The process stopped before it could prove the approved action outcome.'
      WHERE execution_status = 'executing'
        AND execution_started_at < now() - interval '15 minutes'`,
  );
  return result.rowCount ?? 0;
}

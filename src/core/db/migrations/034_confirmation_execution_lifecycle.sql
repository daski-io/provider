ALTER TABLE operator_confirmation_intents
  ADD COLUMN pending_payload_encrypted TEXT,
  ADD COLUMN execution_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (execution_status IN (
      'not_started','executing','succeeded','failed','outcome_unknown'
    )),
  ADD COLUMN execution_started_at TIMESTAMPTZ,
  ADD COLUMN execution_finished_at TIMESTAMPTZ,
  ADD COLUMN execution_error_code TEXT,
  ADD COLUMN execution_error_summary TEXT;

ALTER TABLE operator_confirmation_intents
  DROP CONSTRAINT operator_confirmation_intents_session_id_fkey,
  DROP CONSTRAINT operator_confirmation_intents_approved_session_id_fkey,
  DROP CONSTRAINT operator_confirmation_intents_origin_turn_id_fkey,
  ALTER COLUMN session_id DROP NOT NULL,
  ALTER COLUMN origin_turn_id DROP NOT NULL,
  ADD CONSTRAINT operator_confirmation_intents_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  ADD CONSTRAINT operator_confirmation_intents_approved_session_id_fkey
    FOREIGN KEY (approved_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  ADD CONSTRAINT operator_confirmation_intents_origin_turn_id_fkey
    FOREIGN KEY (origin_turn_id) REFERENCES operator_chats(id) ON DELETE SET NULL;

UPDATE operator_confirmation_intents
   SET execution_status = 'outcome_unknown',
       execution_started_at = consumed_at,
       execution_finished_at = consumed_at,
       execution_error_code = 'legacy_outcome_unproved',
       execution_error_summary =
         'This historical approval was consumed before execution outcomes were tracked.'
 WHERE consumed_at IS NOT NULL;

ALTER TABLE operator_confirmation_intents
  ADD CONSTRAINT operator_confirmation_execution_error_summary_length
    CHECK (
      execution_error_summary IS NULL
      OR length(execution_error_summary) <= 512
    );

CREATE INDEX operator_confirmation_execution_idx
  ON operator_confirmation_intents(execution_status, execution_started_at)
  WHERE execution_status IN ('executing','failed','outcome_unknown');

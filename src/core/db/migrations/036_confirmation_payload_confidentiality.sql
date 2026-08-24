ALTER TABLE operator_confirmation_intents
  ADD COLUMN payload_purged_at TIMESTAMPTZ;

UPDATE operator_confirmation_intents
   SET voided_at = now(),
       execution_status = 'failed',
       execution_finished_at = now(),
       execution_error_code = 'confirmation_payload_unavailable',
       execution_error_summary =
         'The approved action payload is unavailable and cannot be executed.'
 WHERE pending_payload_encrypted IS NULL
   AND consumed_at IS NULL
   AND voided_at IS NULL;

UPDATE operator_confirmation_intents
   SET pending_payload = '{}'::jsonb;

ALTER TABLE operator_confirmation_intents
  DROP COLUMN pending_payload,
  ADD CONSTRAINT operator_confirmation_live_payload_encrypted
    CHECK (
      pending_payload_encrypted IS NOT NULL
      OR voided_at IS NOT NULL
      OR consumed_at IS NOT NULL
    );

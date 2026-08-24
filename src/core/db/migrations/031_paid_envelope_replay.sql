-- Bind each accepted paid task to the privacy-preserving digest of the
-- envelope messageId that created it. An identical SendMessage replay can
-- then return the existing task without reopening execution.
ALTER TABLE transactions
  ADD COLUMN accepted_envelope_message_id_hash BYTEA,
  ADD CONSTRAINT transactions_envelope_message_id_hash_length CHECK (
    accepted_envelope_message_id_hash IS NULL
    OR octet_length(accepted_envelope_message_id_hash) = 32
  );

CREATE UNIQUE INDEX transactions_paid_envelope_message_unique
  ON transactions(buyer_id, accepted_envelope_message_id_hash)
  WHERE accepted_envelope_message_id_hash IS NOT NULL;

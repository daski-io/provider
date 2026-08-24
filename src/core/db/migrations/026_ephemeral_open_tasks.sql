-- Bound anonymous open-skill storage and make message retries idempotent.
ALTER TABLE transactions
  ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'persistent',
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN request_id_hash BYTEA,
  ADD CONSTRAINT transactions_retention_class_check CHECK (
    retention_class IN ('persistent','ephemeral')
  ),
  ADD CONSTRAINT transactions_ephemeral_expiry_check CHECK (
    (retention_class = 'persistent' AND expires_at IS NULL AND request_id_hash IS NULL)
    OR
    (retention_class = 'ephemeral' AND expires_at IS NOT NULL AND request_id_hash IS NOT NULL)
  );

CREATE UNIQUE INDEX transactions_ephemeral_request_unique
  ON transactions(service_id, skill_id, buyer_id, request_id_hash)
  WHERE retention_class = 'ephemeral';

CREATE INDEX transactions_ephemeral_expiry_idx
  ON transactions(expires_at)
  WHERE retention_class = 'ephemeral'
    AND status IN ('completed','failed','canceled');

-- One outcome attestation per (transaction, settlement payment).
--
-- The engine enqueues a reputation submission on every terminal transition,
-- and the admin recovery path (failed -> working -> completed) could enqueue a
-- second, contradictory submission for the same payment — producing duplicate
-- / conflicting permanent on-chain attestations. This unique index makes the
-- queue idempotent per payment; createReputationSubmission() upserts with
-- ON CONFLICT (transaction_id, payment_id) DO NOTHING against it.
--
-- Note: if a pre-existing deploy already has duplicate rows, dedupe them
-- before this migration can apply (pre-production has none).
CREATE UNIQUE INDEX IF NOT EXISTS reputation_submissions_tx_payment_uniq
  ON reputation_submissions (transaction_id, payment_id);

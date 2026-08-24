-- Reputation attestation durability (audit phase 1.10).
--
-- The recorder used to broadcast EAS attest() and only afterwards write the
-- transaction hash; a crash between the two re-attested the same outcome on
-- the next cycle. It now signs first, persists the exact transaction
-- (hash + nonce + encrypted raw bytes) via a conditional pending→submitted
-- claim, and only then broadcasts — mirroring the refund path. Receipt
-- polling is bounded (receipt_checks) with periodic rebroadcast of the
-- stored bytes; exhaustion marks the row failed and raises operator
-- attention instead of polling a dropped transaction forever.
--
-- Outcome supersession: a repaired task (failed -> working -> completed)
-- that re-queues before broadcast replaces the queued outcome in place and
-- records the superseded one; after broadcast the on-chain attestation is
-- immutable (non-revocable schema), so the true final outcome is recorded
-- in post_attest_outcome and surfaced to the operator.

ALTER TABLE reputation_submissions
  ADD COLUMN IF NOT EXISTS nonce BIGINT,
  ADD COLUMN IF NOT EXISTS signed_tx TEXT,
  ADD COLUMN IF NOT EXISTS receipt_checks INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS superseded_outcome INTEGER,
  ADD COLUMN IF NOT EXISTS post_attest_outcome INTEGER;

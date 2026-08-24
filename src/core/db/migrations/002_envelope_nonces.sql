-- A2A envelope-auth replay ledger. Added in v4 by commit f78faf2
-- Used for authenticated A2A envelopes and service capabilities.
--
-- 001_initial.sql declares the same table; this migration only fires on
-- environments that ran 001 before the envelope_nonces DDL existed
-- there. New environments pick up the table from 001 and the
-- IF NOT EXISTS guards make this file a no-op for them.
--
-- See SECURITY.md → "Replay defence (envelope)" for the why.

CREATE TABLE IF NOT EXISTS envelope_nonces (
    buyer_token_id   NUMERIC(78, 0) NOT NULL,
    message_id       TEXT NOT NULL,
    used_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (buyer_token_id, message_id)
);

CREATE INDEX IF NOT EXISTS envelope_nonces_used_at_idx ON envelope_nonces(used_at);

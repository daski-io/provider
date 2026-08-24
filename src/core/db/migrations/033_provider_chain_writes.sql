-- Durable provider-wallet write coordination. The local cursor prevents an RPC
-- provider's lagging pending nonce from assigning one nonce to two writes.
CREATE TABLE provider_chain_writes (
  id UUID PRIMARY KEY,
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  wallet_address TEXT NOT NULL CHECK (
    wallet_address = lower(wallet_address)
    AND wallet_address ~ '^0x[0-9a-f]{40}$'
  ),
  nonce BIGINT NOT NULL CHECK (nonce >= 0),
  purpose TEXT NOT NULL CHECK (purpose IN (
    'reputation_attestation',
    'refund_approval',
    'refund',
    'service_registration',
    'service_uri_update',
    'nonce_cancel'
  )),
  target_type TEXT NOT NULL CHECK (length(target_type) BETWEEN 1 AND 64),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 256),
  intent_hash TEXT NOT NULL CHECK (intent_hash ~ '^0x[0-9a-f]{64}$'),
  transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  signed_tx_encrypted TEXT CHECK (
    signed_tx_encrypted IS NULL OR signed_tx_encrypted LIKE 'daski:v1:%'
  ),
  status TEXT NOT NULL CHECK (status IN (
    'prepared','broadcast','confirmed','reverted','replaced','attention'
  )),
  supersedes_write_id UUID REFERENCES provider_chain_writes(id),
  replacement_write_id UUID REFERENCES provider_chain_writes(id),
  fee_bump_count INTEGER NOT NULL DEFAULT 0 CHECK (fee_bump_count >= 0),
  broadcast_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  signed_tx_purged_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX provider_chain_writes_current_nonce
  ON provider_chain_writes(chain_id, wallet_address, nonce)
  WHERE status <> 'replaced';
CREATE UNIQUE INDEX provider_chain_writes_hash
  ON provider_chain_writes(chain_id, wallet_address, transaction_hash);
CREATE INDEX provider_chain_writes_reconcile
  ON provider_chain_writes(status, updated_at)
  WHERE status IN ('prepared','broadcast','attention');
CREATE INDEX provider_chain_writes_target
  ON provider_chain_writes(target_type, target_id, created_at DESC);

CREATE TABLE provider_signer_cursors (
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  wallet_address TEXT NOT NULL CHECK (
    wallet_address = lower(wallet_address)
    AND wallet_address ~ '^0x[0-9a-f]{40}$'
  ),
  next_nonce BIGINT NOT NULL CHECK (next_nonce >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, wallet_address)
);

ALTER TABLE reputation_submissions
  ADD COLUMN provider_write_id UUID REFERENCES provider_chain_writes(id),
  ADD COLUMN prepare_failures INTEGER NOT NULL DEFAULT 0 CHECK (prepare_failures >= 0),
  ADD COLUMN requeue_count INTEGER NOT NULL DEFAULT 0 CHECK (requeue_count >= 0),
  ADD COLUMN next_action_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE reputation_submissions
  DROP CONSTRAINT reputation_submissions_status_check;
ALTER TABLE reputation_submissions
  ADD CONSTRAINT reputation_submissions_status_check CHECK (
    status IN ('pending','submitted','reconciliation_required','confirmed','failed')
  );

CREATE INDEX reputation_submissions_reconcile
  ON reputation_submissions(status, next_action_at, created_at)
  WHERE status IN ('pending','submitted','reconciliation_required');

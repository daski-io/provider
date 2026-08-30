-- Minimal provider baseline. This schema is intentionally limited to
-- transaction replay safety, admitted chain evidence, rate limiting, and the
-- opt-in supplier mutation journal.

CREATE TABLE provider_transactions (
  id TEXT PRIMARY KEY,
  gateway_audience TEXT NOT NULL,
  order_id TEXT NOT NULL,
  dispatch_nonce BYTEA NOT NULL UNIQUE CHECK (octet_length(dispatch_nonce) = 32),
  dispatch_hash BYTEA NOT NULL CHECK (octet_length(dispatch_hash) = 32),
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
  payer TEXT NOT NULL CHECK (payer ~ '^0x[0-9a-fA-F]{40}$'),
  service_slug TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  listing_manifest_hash BYTEA NOT NULL CHECK (octet_length(listing_manifest_hash) = 32),
  state TEXT NOT NULL CHECK (state IN ('executing', 'completed', 'failed')),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (gateway_audience, order_id),
  CHECK (
    (state = 'executing' AND completed_at IS NULL AND result IS NULL)
    OR
    (state IN ('completed', 'failed') AND completed_at IS NOT NULL AND result IS NOT NULL)
  )
);

CREATE INDEX provider_transactions_capacity
  ON provider_transactions (listing_manifest_hash, state);

CREATE TABLE standard_evidence_admissions (
  evidence_hash BYTEA PRIMARY KEY CHECK (octet_length(evidence_hash) = 32),
  order_id TEXT NOT NULL,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('deposit', 'release')),
  transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  block_number NUMERIC(78, 0) NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  authorization_key BYTEA,
  release_sequence NUMERIC(20, 0),
  transaction_index INTEGER NOT NULL CHECK (transaction_index >= 0),
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  source_fingerprints JSONB NOT NULL,
  canonical_evidence JSONB NOT NULL,
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, evidence_kind),
  UNIQUE (block_number, transaction_index, log_index, evidence_kind),
  CHECK (
    (evidence_kind = 'deposit' AND authorization_key IS NOT NULL AND release_sequence IS NULL)
    OR
    (evidence_kind = 'release' AND authorization_key IS NULL AND release_sequence IS NOT NULL)
  )
);

CREATE UNIQUE INDEX standard_evidence_authorization_key
  ON standard_evidence_admissions (authorization_key)
  WHERE authorization_key IS NOT NULL;

CREATE TABLE supplier_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id TEXT NOT NULL,
  transaction_id TEXT,
  op_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'intent'
    CHECK (state IN ('intent', 'ambiguous', 'confirmed', 'failed')),
  request_fingerprint TEXT,
  result JSONB,
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service_id, op_key)
);

CREATE TABLE rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  tokens DOUBLE PRECISION NOT NULL,
  last_refill TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX rate_limit_buckets_expiry ON rate_limit_buckets (expires_at);

-- Daski-assisted onboarding installs verified immutable runtime bundles here.
-- Promotion supersedes the current head without rewriting history.
CREATE TABLE provider_runtime_listing_versions (
  id UUID PRIMARY KEY,
  gateway_origin TEXT NOT NULL,
  service_id BYTEA NOT NULL CHECK (octet_length(service_id) = 32),
  skill_id TEXT NOT NULL CHECK (length(skill_id) BETWEEN 1 AND 96),
  listing_id UUID NOT NULL,
  listing_key BYTEA NOT NULL CHECK (octet_length(listing_key) = 32),
  payment_required BOOLEAN NOT NULL,
  runtime_commitment_hash BYTEA NOT NULL CHECK (
    octet_length(runtime_commitment_hash) = 32
  ),
  runtime_commitment JSONB NOT NULL,
  bundle JSONB NOT NULL,
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ,
  UNIQUE (gateway_origin, service_id, skill_id, runtime_commitment_hash)
);

CREATE UNIQUE INDEX provider_runtime_listing_heads
  ON provider_runtime_listing_versions(gateway_origin, service_id, skill_id)
  WHERE superseded_at IS NULL;

-- Standard-rail provider admission. Standard tasks bind directly to the payer
-- and Daski order; no native payment ID, service reference, or buyer token ID
-- is synthesized.

ALTER TABLE transactions ALTER COLUMN buyer_id DROP NOT NULL;
ALTER TABLE transactions
  ADD COLUMN standard_order_id TEXT UNIQUE,
  ADD COLUMN standard_payer TEXT,
  ADD COLUMN standard_listing_manifest_hash BYTEA,
  ADD COLUMN standard_provider_offer_hash BYTEA,
  ADD COLUMN standard_deposit_evidence_hash BYTEA,
  ADD COLUMN standard_release_evidence_hash BYTEA,
  ADD COLUMN standard_token TEXT,
  ADD COLUMN standard_gross_amount NUMERIC(78,0),
  ADD COLUMN standard_provider_net_amount NUMERIC(78,0),
  ADD COLUMN standard_daski_commission_amount NUMERIC(78,0),
  ADD CONSTRAINT transactions_standard_authority_check CHECK (
    (buyer_id IS NOT NULL AND standard_order_id IS NULL AND standard_payer IS NULL)
    OR
    (buyer_id IS NULL AND standard_order_id IS NOT NULL AND standard_payer IS NOT NULL)
  ),
  ADD CONSTRAINT transactions_standard_hashes_check CHECK (
    (standard_listing_manifest_hash IS NULL OR octet_length(standard_listing_manifest_hash)=32)
    AND (standard_provider_offer_hash IS NULL OR octet_length(standard_provider_offer_hash)=32)
    AND (standard_deposit_evidence_hash IS NULL OR octet_length(standard_deposit_evidence_hash)=32)
    AND (standard_release_evidence_hash IS NULL OR octet_length(standard_release_evidence_hash)=32)
  ),
  ADD CONSTRAINT transactions_standard_amounts_check CHECK (
    (standard_order_id IS NULL AND standard_token IS NULL AND
      standard_gross_amount IS NULL AND standard_provider_net_amount IS NULL AND
      standard_daski_commission_amount IS NULL)
    OR
    (standard_order_id IS NOT NULL AND standard_token IS NOT NULL AND
      standard_gross_amount > 0 AND standard_provider_net_amount > 0 AND
      standard_daski_commission_amount > 0 AND
      standard_provider_net_amount + standard_daski_commission_amount = standard_gross_amount)
  );

CREATE TABLE standard_dispatch_claims (
  gateway_audience TEXT NOT NULL,
  order_id TEXT NOT NULL,
  dispatch_nonce BYTEA NOT NULL CHECK (octet_length(dispatch_nonce)=32),
  dispatch_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(dispatch_hash)=32),
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash)=32),
  payer TEXT NOT NULL,
  transaction_id TEXT REFERENCES transactions(id),
  state TEXT NOT NULL CHECK (state IN (
    'claimed','dispatching','submitted','working','input-required','completed','failed','canceled'
  )),
  response_hash BYTEA CHECK (response_hash IS NULL OR octet_length(response_hash)=32),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  PRIMARY KEY (gateway_audience, order_id),
  UNIQUE (gateway_audience, dispatch_nonce)
);

CREATE TABLE standard_evidence_admissions (
  evidence_hash BYTEA PRIMARY KEY CHECK (octet_length(evidence_hash)=32),
  order_id TEXT NOT NULL,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('deposit','release')),
  transaction_hash TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  block_hash TEXT NOT NULL,
  transaction_index INTEGER NOT NULL CHECK (transaction_index >= 0),
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  release_sequence NUMERIC(20,0),
  source_fingerprints JSONB NOT NULL,
  canonical_evidence JSONB NOT NULL,
  CHECK (
    (evidence_kind = 'deposit' AND release_sequence IS NULL) OR
    (evidence_kind = 'release' AND release_sequence BETWEEN 1 AND 18446744073709551615)
  ),
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, evidence_kind, transaction_hash, log_index)
);

CREATE TABLE standard_provider_quotes (
  quote_hash BYTEA PRIMARY KEY CHECK (octet_length(quote_hash)=32),
  outcome_id TEXT NOT NULL,
  listing_manifest_hash BYTEA NOT NULL CHECK (octet_length(listing_manifest_hash)=32),
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash)=32),
  gross_amount NUMERIC(78,0) NOT NULL CHECK (gross_amount > 0),
  supplier_cost_ceiling JSONB,
  issued_at TIMESTAMPTZ NOT NULL,
  valid_before TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX standard_provider_quotes_dispatch_idx
  ON standard_provider_quotes(outcome_id,listing_manifest_hash,request_hash,gross_amount,issued_at DESC);

CREATE TABLE standard_action_nonces (
  payer TEXT NOT NULL,
  nonce BYTEA NOT NULL CHECK (octet_length(nonce)=32),
  order_id TEXT NOT NULL,
  action TEXT NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (payer, nonce)
);

CREATE INDEX standard_action_nonces_consumed_idx ON standard_action_nonces(consumed_at);

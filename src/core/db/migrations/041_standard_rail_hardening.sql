-- Close provider-side replay domains and retain security/reconciliation events.

-- A release event may legitimately prove every order in its release interval.
CREATE UNIQUE INDEX standard_evidence_chain_locator_unique_idx
  ON standard_evidence_admissions (lower(transaction_hash), log_index)
  WHERE evidence_kind = 'deposit';

ALTER TABLE standard_evidence_admissions
  ADD COLUMN authorization_key BYTEA
  CHECK (authorization_key IS NULL OR octet_length(authorization_key)=32);

CREATE UNIQUE INDEX standard_evidence_authorization_unique_idx
  ON standard_evidence_admissions (authorization_key)
  WHERE authorization_key IS NOT NULL;

CREATE UNIQUE INDEX standard_dispatch_transaction_unique_idx
  ON standard_dispatch_claims (transaction_id)
  WHERE transaction_id IS NOT NULL;

CREATE TABLE standard_security_incidents (
  incident_id UUID PRIMARY KEY,
  incident_kind TEXT NOT NULL,
  gateway_audience TEXT,
  order_id TEXT,
  fingerprint BYTEA NOT NULL CHECK (octet_length(fingerprint)=32),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (incident_kind, fingerprint)
);

CREATE INDEX standard_security_incidents_open_idx
  ON standard_security_incidents (detected_at)
  WHERE resolved_at IS NULL;

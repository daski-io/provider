-- Signed fixed readiness quotes. A funded dispatch binds the gateway QuoteV1
-- to one row through its providerQuoteHash, so rows are retained for the
-- gateway's whole dispatch-recovery window; quoting reserves nothing.
CREATE TABLE provider_quotes (
  quote_hash BYTEA PRIMARY KEY CHECK (octet_length(quote_hash) = 32),
  outcome_id TEXT NOT NULL CHECK (length(outcome_id) BETWEEN 1 AND 128),
  listing_manifest_hash BYTEA NOT NULL CHECK (octet_length(listing_manifest_hash) = 32),
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
  gross_amount TEXT NOT NULL CHECK (gross_amount ~ '^[1-9][0-9]{0,77}$'),
  payer TEXT CHECK (payer IS NULL OR payer ~ '^0x[0-9a-f]{40}$'),
  issued_at BIGINT NOT NULL CHECK (issued_at > 0),
  valid_before BIGINT NOT NULL CHECK (valid_before > issued_at),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

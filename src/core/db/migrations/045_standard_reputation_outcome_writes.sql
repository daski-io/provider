ALTER TABLE provider_chain_writes
  DROP CONSTRAINT provider_chain_writes_purpose_check;

ALTER TABLE provider_chain_writes
  ADD CONSTRAINT provider_chain_writes_purpose_check CHECK (purpose IN (
    'reputation_attestation',
    'refund_approval',
    'refund',
    'service_registration',
    'service_uri_update',
    'nonce_cancel',
    'standard_reputation_outcome'
  ));

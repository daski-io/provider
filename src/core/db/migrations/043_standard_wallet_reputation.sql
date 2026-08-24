-- Destructive preproduction cutover from ERC-8004 buyer identities to wallet
-- customers. Refuse to erase legacy data: deployment preflight must prove the
-- retired lane is empty before this migration can run.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM buyers LIMIT 1) THEN
    RAISE EXCEPTION 'legacy buyer rows must be reviewed and purged before the wallet cutover';
  END IF;
END $$;

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_known_email TEXT,
  last_known_email_hash TEXT,
  CONSTRAINT customers_wallet_canonical CHECK (wallet_address = lower(wallet_address)),
  CONSTRAINT customers_wallet_shape CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  UNIQUE (wallet_address)
);
CREATE INDEX customers_email_hash_idx ON customers(last_known_email_hash)
  WHERE last_known_email_hash IS NOT NULL;

ALTER TABLE transactions
  ADD COLUMN customer_id UUID REFERENCES customers(id),
  ADD COLUMN standard_order_key BYTEA
    CHECK (standard_order_key IS NULL OR octet_length(standard_order_key) = 32),
  ADD COLUMN standard_action_execution_id BYTEA UNIQUE
    CHECK (standard_action_execution_id IS NULL OR octet_length(standard_action_execution_id) = 32);
INSERT INTO customers (wallet_address)
SELECT DISTINCT lower(standard_payer)
  FROM transactions
 WHERE standard_payer IS NOT NULL
ON CONFLICT (wallet_address) DO NOTHING;
UPDATE transactions t
   SET customer_id = c.id
  FROM customers c
 WHERE lower(t.standard_payer) = c.wallet_address;

ALTER TABLE transactions DROP CONSTRAINT transactions_standard_authority_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_standard_authority_check CHECK (
  (standard_order_id IS NULL AND standard_order_key IS NULL
    AND standard_action_execution_id IS NULL AND standard_payer IS NULL AND customer_id IS NULL)
  OR
  (standard_order_id IS NOT NULL AND standard_action_execution_id IS NULL
    AND standard_order_key IS NOT NULL AND standard_payer IS NOT NULL AND customer_id IS NOT NULL)
  OR
  (standard_order_id IS NULL AND standard_action_execution_id IS NOT NULL
    AND standard_payer IS NOT NULL AND customer_id IS NOT NULL)
);
DROP INDEX IF EXISTS transactions_buyer_idx;
DROP INDEX IF EXISTS transactions_ephemeral_request_unique;
DROP INDEX IF EXISTS transactions_paid_envelope_message_unique;
ALTER TABLE transactions DROP COLUMN buyer_id;
CREATE INDEX transactions_customer_created_idx
  ON transactions(customer_id, created_at DESC, id DESC)
  WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX transactions_ephemeral_request_unique
  ON transactions(service_id, skill_id, request_id_hash)
  WHERE retention_class = 'ephemeral';

ALTER TABLE emails_inbound DROP COLUMN buyer_id;
ALTER TABLE emails_inbound ADD COLUMN customer_id UUID REFERENCES customers(id);
ALTER TABLE emails_outbound DROP COLUMN buyer_id;
ALTER TABLE emails_outbound ADD COLUMN customer_id UUID REFERENCES customers(id);
DROP TABLE capability_nonces;
DROP TABLE envelope_nonces;
DROP TABLE buyers;

ALTER TABLE skills
  DROP COLUMN requires_capability,
  DROP COLUMN capability_type;

ALTER TABLE blocked_identities DROP CONSTRAINT blocked_identities_target;
DROP INDEX IF EXISTS blocked_identities_token_idx;
ALTER TABLE blocked_identities DROP COLUMN buyer_token_id;
ALTER TABLE blocked_identities ADD CONSTRAINT blocked_identities_wallet_required
  CHECK (wallet_address IS NOT NULL);

CREATE TABLE standard_wallet_action_nonces (
  payer TEXT NOT NULL,
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 32),
  action_hash BYTEA NOT NULL CHECK (octet_length(action_hash) = 32),
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
  wallet_authorization_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(wallet_authorization_hash) = 32),
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (payer, nonce)
);
CREATE INDEX standard_wallet_action_nonces_consumed_idx
  ON standard_wallet_action_nonces(consumed_at);

CREATE TABLE standard_provider_grant_nonces (
  grant_nonce BYTEA PRIMARY KEY CHECK (octet_length(grant_nonce) = 32),
  grant_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(grant_hash) = 32),
  payer TEXT NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX standard_provider_grant_nonces_consumed_idx
  ON standard_provider_grant_nonces(consumed_at);

CREATE TABLE standard_asset_rate_buckets (
  scope TEXT NOT NULL CHECK (scope IN ('gateway-signer','payer','global')),
  key_hash BYTEA NOT NULL CHECK (octet_length(key_hash) = 32),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (scope,key_hash)
);

CREATE TABLE standard_asset_action_executions (
  execution_id BYTEA PRIMARY KEY CHECK (octet_length(execution_id) = 32),
  payer TEXT NOT NULL,
  provider_asset_id UUID NOT NULL REFERENCES assets(id),
  action_hash BYTEA NOT NULL CHECK (octet_length(action_hash) = 32),
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
  wallet_authorization_hash BYTEA NOT NULL CHECK (octet_length(wallet_authorization_hash) = 32),
  grant_hash BYTEA NOT NULL CHECK (octet_length(grant_hash) = 32),
  provider_control_profile_hash BYTEA NOT NULL CHECK (octet_length(provider_control_profile_hash) = 32),
  servicing_admission_hash BYTEA NOT NULL CHECK (octet_length(servicing_admission_hash) = 32),
  action_catalog_hash BYTEA NOT NULL CHECK (octet_length(action_catalog_hash) = 32),
  action_catalog_schema_hash BYTEA NOT NULL CHECK (octet_length(action_catalog_schema_hash) = 32),
  action_catalog_epoch BIGINT NOT NULL,
  action_definition_hash BYTEA NOT NULL CHECK (octet_length(action_definition_hash) = 32),
  replay_policy TEXT NOT NULL CHECK (replay_policy IN (
    'stable-result','regenerate-ephemeral','redacted-after-window'
  )),
  state TEXT NOT NULL CHECK (state IN ('claimed','staged','executing','completed','failed','canceled','expired','attention')),
  reconciliation_identity TEXT,
  effect_summary JSONB,
  confirmation_hash BYTEA CHECK (confirmation_hash IS NULL OR octet_length(confirmation_hash) = 32),
  earliest_execution_at TIMESTAMPTZ,
  stage_valid_before TIMESTAMPTZ,
  result_valid_before TIMESTAMPTZ NOT NULL,
  result_redacted_at TIMESTAMPTZ,
  sanitized_result JSONB,
  error_class TEXT,
  CONSTRAINT standard_asset_action_result_check CHECK (
    (state = 'completed' AND error_class IS NULL AND
      (sanitized_result IS NOT NULL OR replay_policy IN ('regenerate-ephemeral','redacted-after-window')
        OR result_redacted_at IS NOT NULL))
    OR (state = 'failed' AND sanitized_result IS NULL AND error_class IS NOT NULL)
    OR (state NOT IN ('completed','failed') AND sanitized_result IS NULL AND error_class IS NULL)
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX standard_asset_action_executions_payer_idx
  ON standard_asset_action_executions(payer, created_at DESC);

CREATE TABLE standard_destructive_action_payloads (
  execution_id BYTEA PRIMARY KEY REFERENCES standard_asset_action_executions(execution_id) ON DELETE CASCADE,
  encrypted_input TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE standard_asset_action_recovery_results (
  execution_id BYTEA PRIMARY KEY REFERENCES standard_asset_action_executions(execution_id) ON DELETE CASCADE,
  encrypted_result TEXT NOT NULL CHECK (encrypted_result LIKE 'daski:v1:%'),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE standard_asset_action_recovery_executions (
  recovery_execution_id BYTEA PRIMARY KEY CHECK (octet_length(recovery_execution_id) = 32),
  action_execution_id BYTEA NOT NULL REFERENCES standard_asset_action_executions(execution_id),
  payer TEXT NOT NULL,
  wallet_authorization_hash BYTEA NOT NULL CHECK (octet_length(wallet_authorization_hash) = 32),
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE standard_destructive_followup_executions (
  followup_execution_id BYTEA PRIMARY KEY CHECK (octet_length(followup_execution_id) = 32),
  action_execution_id BYTEA NOT NULL REFERENCES standard_asset_action_executions(execution_id),
  payer TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('confirm','cancel')),
  confirmation_hash BYTEA NOT NULL CHECK (octet_length(confirmation_hash) = 32),
  wallet_authorization_hash BYTEA NOT NULL CHECK (octet_length(wallet_authorization_hash) = 32),
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE standard_reputation_outcomes (
  order_key BYTEA PRIMARY KEY CHECK (octet_length(order_key) = 32),
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id),
  outcome SMALLINT NOT NULL CHECK (outcome BETWEEN 0 AND 2),
  state TEXT NOT NULL CHECK (state IN ('pending','broadcast','final','operator_attention','aborted_unattested')),
  transaction_hash TEXT UNIQUE,
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  retry_once_used BOOLEAN NOT NULL DEFAULT false,
  provider_write_id UUID REFERENCES provider_chain_writes(id),
  next_attempt_at TIMESTAMPTZ DEFAULT now(),
  last_error_class TEXT,
  final_block_number BIGINT,
  final_block_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX standard_reputation_outcomes_work_idx
  ON standard_reputation_outcomes(state, next_attempt_at);

CREATE INDEX transactions_standard_asset_owner_idx
  ON transactions(asset_id, created_at DESC, id DESC)
  INCLUDE (standard_payer)
  WHERE asset_id IS NOT NULL AND standard_payer IS NOT NULL;

DROP POLICY IF EXISTS provider_chain_writes_registry_runtime ON provider_chain_writes;
CREATE POLICY provider_chain_writes_standard_runtime
  ON provider_chain_writes
  USING (purpose IN ('service_registration', 'service_uri_update', 'standard_reputation_outcome'))
  WITH CHECK (purpose IN ('service_registration', 'service_uri_update', 'standard_reputation_outcome'));

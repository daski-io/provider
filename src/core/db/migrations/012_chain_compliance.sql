-- Security audit 2026-07-10: chain-integrity, financial state, compliance,
-- and persistent operator-configuration invariants.

-- EVM uint256 values must never pass through PostgreSQL BIGINT.
ALTER TABLE buyers ALTER COLUMN token_id TYPE NUMERIC(78, 0);
ALTER TABLE payments ALTER COLUMN onchain_payment_id TYPE NUMERIC(78, 0);
ALTER TABLE payments ALTER COLUMN amount TYPE NUMERIC(78, 0);
ALTER TABLE payments ALTER COLUMN buyer_agent_id TYPE NUMERIC(78, 0);
ALTER TABLE payments ALTER COLUMN provider_agent_id TYPE NUMERIC(78, 0);
ALTER TABLE payments ALTER COLUMN provider_amount TYPE NUMERIC(78, 0);
ALTER TABLE payments ALTER COLUMN commission TYPE NUMERIC(78, 0);

-- NUMERIC(78,0) has a slightly wider range than uint256, so retain the
-- exact EVM boundary explicitly (refund amounts are stored as negatives).
ALTER TABLE buyers ADD CONSTRAINT buyers_token_id_uint256 CHECK (
  token_id >= 0 AND token_id <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
);
ALTER TABLE payments ADD CONSTRAINT payments_payment_id_uint256 CHECK (
  onchain_payment_id >= 0 AND onchain_payment_id <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
);
ALTER TABLE payments ADD CONSTRAINT payments_amount_uint256_signed CHECK (
  amount BETWEEN -115792089237316195423570985008687907853269984665640564039457584007913129639935
             AND 115792089237316195423570985008687907853269984665640564039457584007913129639935
);
ALTER TABLE payments ADD CONSTRAINT payments_agent_ids_uint256 CHECK (
  (buyer_agent_id IS NULL OR buyer_agent_id BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935)
  AND (provider_agent_id IS NULL OR provider_agent_id BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935)
);
ALTER TABLE payments ADD CONSTRAINT payments_breakdown_uint256 CHECK (
  (provider_amount IS NULL OR provider_amount BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935)
  AND (commission IS NULL OR commission BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935)
);

ALTER TABLE payments ADD COLUMN chain_id INTEGER;
ALTER TABLE payments ADD COLUMN router_address TEXT;
ALTER TABLE payments ADD COLUMN block_number NUMERIC(78, 0);
ALTER TABLE payments ADD COLUMN block_hash TEXT;
ALTER TABLE payments ADD COLUMN log_index INTEGER;
ALTER TABLE payments ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (
  status IN (
    'verified','disputed','proposed','reserved','approval_broadcast',
    'broadcast','pending_confirmation','reconciliation_required',
    'issued','failed','rejected'
  )
);

CREATE UNIQUE INDEX payments_authoritative_settlement_unique
  ON payments(chain_id, lower(router_address), onchain_payment_id)
  WHERE amount > 0;
CREATE INDEX payments_refund_reconciliation_idx
  ON payments(status, updated_at)
  WHERE amount < 0 AND status IN (
    'reserved','approval_broadcast','broadcast','pending_confirmation',
    'reconciliation_required'
  );

-- A verified chain settlement is persisted before any untrusted request data
-- is authenticated. Only chain facts are permitted in this table.
CREATE TABLE settlement_observations (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chain_id               INTEGER NOT NULL,
    router_address         TEXT NOT NULL,
    onchain_payment_id     NUMERIC(78, 0) NOT NULL,
    transaction_hash       TEXT NOT NULL,
    block_number           NUMERIC(78, 0) NOT NULL,
    block_hash             TEXT NOT NULL,
    log_index              INTEGER NOT NULL,
    confirmations          INTEGER NOT NULL,
    service_ref            BYTEA NOT NULL,
    onchain_service_id     BYTEA NOT NULL,
    buyer_agent_id         NUMERIC(78, 0) NOT NULL,
    provider_agent_id      NUMERIC(78, 0) NOT NULL,
    token_address          TEXT NOT NULL,
    total_amount           NUMERIC(78, 0) NOT NULL,
    provider_amount        NUMERIC(78, 0) NOT NULL,
    commission             NUMERIC(78, 0) NOT NULL,
    state                  TEXT NOT NULL DEFAULT 'observed',
    disposition_code       TEXT,
    disposition_detail     TEXT,
    authenticated_wallet   TEXT,
    canonical_request_hash BYTEA,
    transaction_id         TEXT REFERENCES transactions(id),
    observed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT settlement_observations_amount_positive CHECK (total_amount > 0),
    CONSTRAINT settlement_observations_uint256_check CHECK (
      onchain_payment_id BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935
      AND block_number BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935
      AND buyer_agent_id BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935
      AND provider_agent_id BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935
      AND total_amount BETWEEN 1 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935
      AND provider_amount BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935
      AND commission BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935
    ),
    CONSTRAINT settlement_observations_state_check CHECK (
      state IN (
        'observed','authenticated','materialized','fulfilling','completed',
        'refund_required','compliance_hold','operator_review'
      )
    ),
    CONSTRAINT settlement_observations_disposition_code_check CHECK (
      disposition_code IS NULL OR disposition_code ~ '^[a-z0-9_]{1,64}$'
    ),
    CONSTRAINT settlement_observations_disposition_detail_check CHECK (
      disposition_detail IS NULL OR length(disposition_detail) <= 256
    ),
    UNIQUE (chain_id, router_address, onchain_payment_id),
    UNIQUE (chain_id, transaction_hash, log_index)
);
CREATE INDEX settlement_observations_incomplete_idx
  ON settlement_observations(state, updated_at)
  WHERE state NOT IN ('completed','compliance_hold');
CREATE INDEX settlement_observations_service_ref_idx
  ON settlement_observations(service_ref);

CREATE TABLE settlement_dispositions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    observation_id  UUID NOT NULL UNIQUE REFERENCES settlement_observations(id),
    transaction_id  TEXT REFERENCES transactions(id),
    action          TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',
    reason          TEXT NOT NULL,
    escalation_id   UUID REFERENCES escalations(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT settlement_dispositions_action_check CHECK (
      action IN ('refund','compliance_hold','operator_review')
    ),
    CONSTRAINT settlement_dispositions_status_check CHECK (
      status IN ('open','dispatched','closed')
    ),
    CONSTRAINT settlement_dispositions_reason_check CHECK (length(reason) <= 256)
);

-- Provider-issued immutable quote commitments. The on-chain serviceRef must
-- equal service_ref below, which makes the settled event commit to this row.
CREATE TABLE provider_quotes (
    id                 UUID PRIMARY KEY,
    service_ref        BYTEA NOT NULL UNIQUE,
    service_id         UUID NOT NULL REFERENCES services(id),
    skill_id           TEXT NOT NULL,
    canonical_args_hash BYTEA NOT NULL,
    amount             NUMERIC(78, 0) NOT NULL,
    token_address      TEXT NOT NULL,
    chain_id           INTEGER NOT NULL,
    quote_version      TEXT NOT NULL,
    signed_payload     JSONB NOT NULL,
    provider_signature TEXT NOT NULL,
    signer_address     TEXT NOT NULL,
    signing_key_id     TEXT NOT NULL,
    issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at         TIMESTAMPTZ NOT NULL,
    consumed_at        TIMESTAMPTZ,
    observation_id     UUID REFERENCES settlement_observations(id),
    CONSTRAINT provider_quotes_amount_positive CHECK (
      amount BETWEEN 1 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935
    ),
    CONSTRAINT provider_quotes_expiry CHECK (expires_at > issued_at)
);
CREATE INDEX provider_quotes_expiry_idx ON provider_quotes(expires_at);

-- Optimistic transaction transitions. Every state change names the version it
-- observed; stale writers cannot overwrite a cancellation/completion race.
ALTER TABLE transactions ADD COLUMN version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE transactions ADD COLUMN canonical_request_hash BYTEA;

-- Shared durable work primitive used by financial reconciliation and other
-- security-critical jobs. Queue/idempotency uniqueness survives restarts and
-- rolling deployments.
CREATE TABLE durable_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    queue           TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload         JSONB NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'queued',
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 12,
    available_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_owner     TEXT,
    lease_expires_at TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    CONSTRAINT durable_jobs_status_check CHECK (
      status IN ('queued','running','retry','dead_letter','completed')
    ),
    CONSTRAINT durable_jobs_attempts_check CHECK (attempts >= 0 AND max_attempts > 0),
    UNIQUE (queue, idempotency_key)
);
CREATE INDEX durable_jobs_claim_idx
  ON durable_jobs(queue, available_at, created_at)
  WHERE status IN ('queued','retry');
CREATE INDEX durable_jobs_lease_idx
  ON durable_jobs(lease_expires_at)
  WHERE status = 'running';

-- Confirmed sanctions cases have an enforceable runbook rather than prose.
CREATE TABLE compliance_cases (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    screening_check_id    UUID NOT NULL UNIQUE,
    transaction_id        TEXT REFERENCES transactions(id),
    asset_id              UUID REFERENCES assets(id),
    status                TEXT NOT NULL DEFAULT 'confirmed',
    rules_version         TEXT NOT NULL,
    confirmed_by          TEXT NOT NULL,
    confirmed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    counsel_due_at        TIMESTAMPTZ NOT NULL,
    counsel_contacted_at  TIMESTAMPTZ,
    counsel_alerted_at    TIMESTAMPTZ,
    report_due_at         TIMESTAMPTZ NOT NULL,
    report_submitted_at   TIMESTAMPTZ,
    report_alerted_at     TIMESTAMPTZ,
    funds_segregated_at   TIMESTAMPTZ,
    blocked_funds_address TEXT NOT NULL,
    evidence              TEXT NOT NULL CHECK (evidence LIKE 'daski:v1:%'),
    closed_at             TIMESTAMPTZ,
    closed_by             TEXT,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT compliance_cases_status_check CHECK (
      status IN (
        'confirmed','counsel_contacted','funds_segregated',
        'report_submitted','ready_to_close','closed'
      )
    )
);
CREATE INDEX compliance_cases_deadline_idx
  ON compliance_cases(counsel_due_at, report_due_at)
  WHERE status <> 'closed';

-- Immutable approval evidence gates live screening. A new rules or
-- country-map version requires a new approval row; old evidence is retained.
CREATE TABLE compliance_governance_approvals (
    id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    environment                TEXT NOT NULL,
    chain_id                   INTEGER NOT NULL,
    rules_version              TEXT NOT NULL,
    country_mapping_version    TEXT NOT NULL,
    calibration_artifact_hash  TEXT NOT NULL,
    approver                    TEXT NOT NULL CHECK (approver LIKE 'daski:v1:%'),
    approved_at                 TIMESTAMPTZ NOT NULL,
    evidence_reference          TEXT NOT NULL CHECK (evidence_reference LIKE 'daski:v1:%'),
    evidence_reference_hash     TEXT NOT NULL,
    blocked_funds_address       TEXT NOT NULL,
    blocked_funds_ownership_evidence TEXT NOT NULL
      CHECK (blocked_funds_ownership_evidence LIKE 'daski:v1:%'),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX compliance_governance_approval_evidence_unique
  ON compliance_governance_approvals(
    environment, chain_id, rules_version, country_mapping_version,
    lower(blocked_funds_address), evidence_reference_hash
  );

CREATE FUNCTION reject_compliance_governance_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND current_setting('daski.protected_data_rotation_run', true) IS NOT NULL
    AND EXISTS (SELECT 1 FROM protected_data_rotation_roles WHERE role_name = current_user)
    AND EXISTS (
      SELECT 1 FROM protected_data_rotation_runs
       WHERE id = current_setting('daski.protected_data_rotation_run', true)::uuid
         AND status = 'running'
    )
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'compliance governance approvals are append-only';
END;
$$;
CREATE TRIGGER compliance_governance_approvals_append_only
BEFORE UPDATE OR DELETE ON compliance_governance_approvals
FOR EACH ROW EXECUTE FUNCTION reject_compliance_governance_mutation();

CREATE TABLE compliance_sweep_runs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trigger        TEXT NOT NULL,
    list_version   TEXT NOT NULL,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at   TIMESTAMPTZ,
    next_due_at    TIMESTAMPTZ NOT NULL,
    status         TEXT NOT NULL DEFAULT 'running',
    parties_count  INTEGER,
    holds_count    INTEGER,
    error          TEXT,
    CONSTRAINT compliance_sweep_runs_status_check CHECK (
      status IN ('running','completed','failed')
    )
);
CREATE INDEX compliance_sweep_due_idx
  ON compliance_sweep_runs(next_due_at DESC, completed_at DESC);

-- Operator-owned configuration is revisioned and never re-seeded on restart.
ALTER TABLE services ADD COLUMN config_revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE services ADD COLUMN operator_updated_by TEXT;
ALTER TABLE services ADD COLUMN operator_updated_at TIMESTAMPTZ;
ALTER TABLE supplier_configs ADD COLUMN config_revision BIGINT NOT NULL DEFAULT 1;

CREATE TABLE operator_config_revisions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_type   TEXT NOT NULL,
    resource_key    TEXT NOT NULL,
    revision        BIGINT NOT NULL,
    actor           TEXT NOT NULL,
    changed_fields  TEXT[] NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (resource_type, resource_key, revision)
);

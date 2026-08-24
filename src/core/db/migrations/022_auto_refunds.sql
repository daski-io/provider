-- Automatic fulfillment-refund policy and durable supplier-outage state.

CREATE UNIQUE INDEX payments_one_live_auto_refund_proposal_idx
  ON payments(transaction_id, (metadata #>> '{auto_refund,class}'))
  WHERE amount < 0 AND status = 'proposed'
    AND metadata->>'auto' = 'true'
    AND metadata #>> '{auto_refund,class}' IS NOT NULL;

ALTER TABLE settlement_observations
  DROP CONSTRAINT settlement_observations_state_check;
ALTER TABLE settlement_observations
  ADD CONSTRAINT settlement_observations_state_check CHECK (
    state IN (
      'observed','authenticated','materialized','fulfilling','completed',
      'refund_required','refunded','compliance_hold','operator_review'
    )
  );

DROP INDEX settlement_observations_incomplete_idx;
CREATE INDEX settlement_observations_incomplete_idx
  ON settlement_observations(state, updated_at)
  WHERE state NOT IN ('completed','refunded','compliance_hold');

ALTER TABLE settlement_dispositions
  DROP CONSTRAINT settlement_dispositions_status_check;
ALTER TABLE settlement_dispositions
  ADD CONSTRAINT settlement_dispositions_status_check CHECK (
    status IN ('open','dispatched','closed','resolved')
  );

ALTER TABLE escalations DROP CONSTRAINT escalations_source_check;
ALTER TABLE escalations ADD CONSTRAINT escalations_source_check CHECK (
  source IN (
    'pre_execute','email_agent','operator','auto','fulfillment_hold'
  )
);

ALTER TABLE escalations
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN fulfillment_supplier TEXT,
  ADD COLUMN fulfillment_hold_kind TEXT,
  ADD COLUMN fulfillment_resume_at TIMESTAMPTZ,
  ADD COLUMN fulfillment_attempts INTEGER,
  ADD CONSTRAINT escalations_fulfillment_hold_kind_check CHECK (
    fulfillment_hold_kind IS NULL OR
    fulfillment_hold_kind IN ('outage','provider_config','ambiguous')
  ),
  ADD CONSTRAINT escalations_fulfillment_attempts_check CHECK (
    fulfillment_attempts IS NULL OR fulfillment_attempts >= 0
  );

ALTER TABLE escalations DROP CONSTRAINT escalations_preexecute_snapshot_check;
ALTER TABLE escalations ADD CONSTRAINT escalations_protected_snapshot_check CHECK (
  source NOT IN ('pre_execute','fulfillment_hold') OR (
    execution_snapshot_hash IS NOT NULL AND request_hash IS NOT NULL
    AND snapshot_version = 1 AND snapshot_service_id IS NOT NULL
    AND snapshot_skill_id IS NOT NULL AND (
      execution_snapshot_encrypted IS NOT NULL OR
      (evidence_purged_at IS NOT NULL AND execution_snapshot_encrypted IS NULL)
    )
  )
);

CREATE INDEX escalations_fulfillment_resume_idx
  ON escalations(fulfillment_resume_at)
  WHERE source = 'fulfillment_hold' AND status = 'resolution_queued';

CREATE UNIQUE INDEX escalations_one_open_fulfillment_hold_idx
  ON escalations(transaction_id)
  WHERE source = 'fulfillment_hold' AND status IN (
    'pending','in_agent_review','awaiting_human','resolution_queued',
    'rejection_queued','resolution_executing','resolution_result_ready',
    'resolution_attention'
  );

CREATE TABLE supplier_breaker_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier TEXT NOT NULL,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  failure_kind TEXT NOT NULL,
  failure_key TEXT,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX supplier_breaker_failures_window_idx
  ON supplier_breaker_failures(supplier, failed_at);
CREATE UNIQUE INDEX supplier_breaker_failures_key_idx
  ON supplier_breaker_failures(supplier, failure_key)
  WHERE failure_key IS NOT NULL;

CREATE TABLE supplier_circuit_breakers (
  supplier TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
  opened_at TIMESTAMPTZ,
  open_until TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0,
  task_count INTEGER NOT NULL DEFAULT 0,
  escalation_id UUID REFERENCES escalations(id),
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
  probe_token UUID,
  probe_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_circuit_breakers_probe_check CHECK (
    (state = 'half_open' AND probe_token IS NOT NULL AND probe_expires_at IS NOT NULL)
    OR (state <> 'half_open' AND probe_token IS NULL AND probe_expires_at IS NULL)
  )
);

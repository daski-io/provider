-- Claimed pre-execute review workflow. Protected execution inputs and review
-- evidence use the platform envelope format; only hashes and routing metadata
-- remain queryable. Intermediate states make crash recovery explicit.

CREATE TABLE protected_data_rotation_runs (
  id UUID PRIMARY KEY,
  from_key_id TEXT NOT NULL,
  to_key_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  CONSTRAINT protected_data_rotation_status_check
    CHECK (status IN ('running','failed','completed','rolled_back')),
  CONSTRAINT protected_data_rotation_distinct_keys CHECK (from_key_id <> to_key_id)
);

CREATE TABLE protected_data_rotation_progress (
  run_id UUID NOT NULL REFERENCES protected_data_rotation_runs(id) ON DELETE CASCADE,
  sink TEXT NOT NULL,
  last_record_id TEXT,
  rows_rotated BIGINT NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, sink)
);

CREATE TABLE protected_data_rotation_roles (role_name NAME PRIMARY KEY);
INSERT INTO protected_data_rotation_roles(role_name) VALUES (current_user);

ALTER TABLE escalations DROP CONSTRAINT escalations_status_check;
ALTER TABLE escalations ADD CONSTRAINT escalations_status_check CHECK (
  status IN (
    'pending','in_agent_review','awaiting_human','resolved','rejected',
    'approved','edited','resolution_queued','rejection_queued',
    'resolution_executing','resolution_result_ready','resolution_attention'
  )
);

ALTER TABLE escalations
  ADD COLUMN execution_snapshot_encrypted TEXT,
  ADD COLUMN execution_snapshot_hash TEXT,
  ADD COLUMN request_hash TEXT,
  ADD COLUMN snapshot_version INTEGER,
  ADD COLUMN snapshot_service_id UUID REFERENCES services(id),
  ADD COLUMN snapshot_skill_id TEXT,
  ADD COLUMN snapshot_asset_id UUID REFERENCES assets(id),
  ADD COLUMN reviewer_decision TEXT,
  ADD COLUMN reviewer_actor TEXT,
  ADD COLUMN reviewer_edits_encrypted TEXT,
  ADD COLUMN reviewer_edits_hash TEXT,
  ADD COLUMN review_binding_encrypted TEXT,
  ADD COLUMN review_binding_hash TEXT,
  ADD COLUMN resolution_job_id UUID REFERENCES durable_jobs(id),
  ADD COLUMN resolution_claimed_at TIMESTAMPTZ,
  ADD COLUMN resolution_started_at TIMESTAMPTZ,
  ADD COLUMN adapter_result_encrypted TEXT,
  ADD COLUMN adapter_result_hash TEXT,
  ADD COLUMN resolution_error TEXT,
  ADD COLUMN evidence_purged_at TIMESTAMPTZ,
  ADD CONSTRAINT escalations_snapshot_envelope_check CHECK (
    execution_snapshot_encrypted IS NULL OR execution_snapshot_encrypted LIKE 'daski:v1:%'
  ),
  ADD CONSTRAINT escalations_edits_envelope_check CHECK (
    reviewer_edits_encrypted IS NULL OR reviewer_edits_encrypted LIKE 'daski:v1:%'
  ),
  ADD CONSTRAINT escalations_binding_envelope_check CHECK (
    review_binding_encrypted IS NULL OR review_binding_encrypted LIKE 'daski:v1:%'
  ),
  ADD CONSTRAINT escalations_result_envelope_check CHECK (
    adapter_result_encrypted IS NULL OR adapter_result_encrypted LIKE 'daski:v1:%'
  ),
  ADD CONSTRAINT escalations_review_decision_check CHECK (
    reviewer_decision IS NULL OR reviewer_decision IN ('approved','edited','rejected')
  ),
  ADD CONSTRAINT escalations_preexecute_snapshot_check CHECK (
    source <> 'pre_execute' OR (
      execution_snapshot_hash IS NOT NULL AND request_hash IS NOT NULL
      AND snapshot_version = 1 AND snapshot_service_id IS NOT NULL
      AND snapshot_skill_id IS NOT NULL AND (
        execution_snapshot_encrypted IS NOT NULL OR
        (evidence_purged_at IS NOT NULL AND execution_snapshot_encrypted IS NULL)
      )
    )
  );

CREATE INDEX escalations_resolution_recovery_idx
  ON escalations(status, resolution_claimed_at)
  WHERE status IN (
    'resolution_queued','rejection_queued','resolution_executing',
    'resolution_result_ready','resolution_attention'
  );

CREATE UNIQUE INDEX escalations_one_open_preexecute_idx
  ON escalations(transaction_id)
  WHERE source = 'pre_execute' AND status IN (
    'pending','resolution_queued','rejection_queued','resolution_executing',
    'resolution_result_ready','resolution_attention'
  );

-- Snapshots and reviewer authorization are write-once. A ciphertext transplant,
-- hash replacement, or post-claim argument drift is rejected by the database
-- before the worker can observe it.
CREATE FUNCTION prevent_escalation_evidence_mutation() RETURNS trigger AS $$
DECLARE
  purging BOOLEAN;
  rotation_run TEXT;
BEGIN
  rotation_run := current_setting('daski.protected_data_rotation_run', true);
  IF rotation_run IS NOT NULL
    AND EXISTS (SELECT 1 FROM protected_data_rotation_roles WHERE role_name = current_user)
    AND EXISTS (
      SELECT 1 FROM protected_data_rotation_runs
       WHERE id = rotation_run::uuid AND status = 'running'
    )
  THEN
    RETURN NEW;
  END IF;
  purging := OLD.evidence_purged_at IS NULL
    AND NEW.evidence_purged_at IS NOT NULL
    AND OLD.status IN ('approved','edited','rejected')
    AND NEW.status = OLD.status
    AND NEW.execution_snapshot_encrypted IS NULL
    AND NEW.reviewer_edits_encrypted IS NULL
    AND NEW.review_binding_encrypted IS NULL
    AND NEW.adapter_result_encrypted IS NULL;
  IF purging AND (
    NEW.execution_snapshot_hash IS DISTINCT FROM OLD.execution_snapshot_hash OR
    NEW.request_hash IS DISTINCT FROM OLD.request_hash OR
    NEW.snapshot_version IS DISTINCT FROM OLD.snapshot_version OR
    NEW.snapshot_service_id IS DISTINCT FROM OLD.snapshot_service_id OR
    NEW.snapshot_skill_id IS DISTINCT FROM OLD.snapshot_skill_id OR
    NEW.snapshot_asset_id IS DISTINCT FROM OLD.snapshot_asset_id OR
    NEW.reviewer_decision IS DISTINCT FROM OLD.reviewer_decision OR
    NEW.reviewer_actor IS DISTINCT FROM OLD.reviewer_actor OR
    NEW.reviewer_edits_hash IS DISTINCT FROM OLD.reviewer_edits_hash OR
    NEW.review_binding_hash IS DISTINCT FROM OLD.review_binding_hash OR
    NEW.adapter_result_hash IS DISTINCT FROM OLD.adapter_result_hash
  ) THEN
    RAISE EXCEPTION 'escalation evidence purge cannot alter retained bindings';
  END IF;
  IF NOT purging AND OLD.execution_snapshot_encrypted IS NOT NULL AND (
    NEW.execution_snapshot_encrypted IS DISTINCT FROM OLD.execution_snapshot_encrypted OR
    NEW.execution_snapshot_hash IS DISTINCT FROM OLD.execution_snapshot_hash OR
    NEW.request_hash IS DISTINCT FROM OLD.request_hash OR
    NEW.snapshot_version IS DISTINCT FROM OLD.snapshot_version OR
    NEW.snapshot_service_id IS DISTINCT FROM OLD.snapshot_service_id OR
    NEW.snapshot_skill_id IS DISTINCT FROM OLD.snapshot_skill_id OR
    NEW.snapshot_asset_id IS DISTINCT FROM OLD.snapshot_asset_id
  ) THEN
    RAISE EXCEPTION 'escalation execution snapshot is immutable';
  END IF;
  IF NOT purging AND OLD.reviewer_decision IS NOT NULL AND (
    NEW.reviewer_decision IS DISTINCT FROM OLD.reviewer_decision OR
    NEW.reviewer_actor IS DISTINCT FROM OLD.reviewer_actor OR
    NEW.reviewer_edits_encrypted IS DISTINCT FROM OLD.reviewer_edits_encrypted OR
    NEW.reviewer_edits_hash IS DISTINCT FROM OLD.reviewer_edits_hash OR
    NEW.review_binding_encrypted IS DISTINCT FROM OLD.review_binding_encrypted OR
    NEW.review_binding_hash IS DISTINCT FROM OLD.review_binding_hash
  ) THEN
    RAISE EXCEPTION 'escalation review authorization is immutable';
  END IF;
  IF NOT purging AND OLD.adapter_result_encrypted IS NOT NULL AND (
    NEW.adapter_result_encrypted IS DISTINCT FROM OLD.adapter_result_encrypted OR
    NEW.adapter_result_hash IS DISTINCT FROM OLD.adapter_result_hash
  ) THEN
    RAISE EXCEPTION 'escalation adapter result is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER escalations_evidence_immutable
BEFORE UPDATE ON escalations
FOR EACH ROW EXECUTE FUNCTION prevent_escalation_evidence_mutation();

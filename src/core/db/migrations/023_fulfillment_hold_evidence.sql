-- Append-only authorization and result history for fulfillment-hold retries.

ALTER TABLE escalations
  ADD COLUMN fulfillment_attempt_seq BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT escalations_fulfillment_attempt_seq_check CHECK (
    fulfillment_attempt_seq >= 0
    AND (source = 'fulfillment_hold' OR fulfillment_attempt_seq = 0)
  );

CREATE TABLE fulfillment_hold_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escalation_id UUID NOT NULL REFERENCES escalations(id),
  attempt_seq BIGINT NOT NULL CHECK (attempt_seq > 0),
  snapshot_service_id UUID NOT NULL REFERENCES services(id),
  prior_status TEXT NOT NULL CHECK (
    prior_status IN ('resolution_executing','resolution_result_ready')
  ),
  next_status TEXT NOT NULL CHECK (next_status IN ('pending','resolution_queued')),
  fulfillment_supplier TEXT,
  fulfillment_hold_kind TEXT,
  fulfillment_attempts INTEGER CHECK (
    fulfillment_attempts IS NULL OR fulfillment_attempts >= 0
  ),
  reviewer_decision TEXT CHECK (
    reviewer_decision IS NULL OR reviewer_decision IN ('approved','edited')
  ),
  reviewer_actor TEXT,
  reviewer_edits_encrypted TEXT,
  reviewer_edits_hash TEXT,
  review_binding_encrypted TEXT,
  review_binding_hash TEXT,
  adapter_result_encrypted TEXT,
  adapter_result_hash TEXT,
  resolution_claimed_at TIMESTAMPTZ,
  resolution_started_at TIMESTAMPTZ,
  resolution_error TEXT,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  evidence_purged_at TIMESTAMPTZ,
  UNIQUE (escalation_id, attempt_seq),
  CHECK (reviewer_edits_encrypted IS NULL OR reviewer_edits_encrypted LIKE 'daski:v1:%'),
  CHECK (review_binding_encrypted IS NULL OR review_binding_encrypted LIKE 'daski:v1:%'),
  CHECK (adapter_result_encrypted IS NULL OR adapter_result_encrypted LIKE 'daski:v1:%'),
  CHECK (resolution_error IS NULL OR resolution_error LIKE 'daski:v1:%'),
  CHECK (
    evidence_purged_at IS NULL OR (
      reviewer_edits_encrypted IS NULL
      AND review_binding_encrypted IS NULL
      AND adapter_result_encrypted IS NULL
      AND resolution_error IS NULL
    )
  )
);
CREATE INDEX fulfillment_hold_attempts_escalation_idx
  ON fulfillment_hold_attempts(escalation_id, archived_at);

CREATE FUNCTION prevent_fulfillment_hold_attempt_mutation() RETURNS trigger AS $$
DECLARE
  current_hold escalations%ROWTYPE;
  rotation_run TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO current_hold FROM escalations
     WHERE id = NEW.escalation_id FOR UPDATE;
    IF NOT FOUND
      OR current_hold.source <> 'fulfillment_hold'
      OR current_hold.status NOT IN ('resolution_executing','resolution_result_ready')
      OR current_hold.fulfillment_attempt_seq >= 9223372036854775807
      OR NEW.attempt_seq <> current_hold.fulfillment_attempt_seq + 1
      OR NEW.snapshot_service_id IS DISTINCT FROM current_hold.snapshot_service_id
      OR NEW.prior_status <> current_hold.status
      OR NEW.fulfillment_supplier IS DISTINCT FROM current_hold.fulfillment_supplier
      OR NEW.fulfillment_hold_kind IS DISTINCT FROM current_hold.fulfillment_hold_kind
      OR NEW.fulfillment_attempts IS DISTINCT FROM current_hold.fulfillment_attempts
      OR NEW.reviewer_decision IS DISTINCT FROM current_hold.reviewer_decision
      OR NEW.reviewer_actor IS DISTINCT FROM current_hold.reviewer_actor
      OR NEW.reviewer_edits_encrypted IS DISTINCT FROM current_hold.reviewer_edits_encrypted
      OR NEW.reviewer_edits_hash IS DISTINCT FROM current_hold.reviewer_edits_hash
      OR NEW.review_binding_encrypted IS DISTINCT FROM current_hold.review_binding_encrypted
      OR NEW.review_binding_hash IS DISTINCT FROM current_hold.review_binding_hash
      OR NEW.adapter_result_encrypted IS DISTINCT FROM current_hold.adapter_result_encrypted
      OR NEW.adapter_result_hash IS DISTINCT FROM current_hold.adapter_result_hash
      OR NEW.resolution_claimed_at IS DISTINCT FROM current_hold.resolution_claimed_at
      OR NEW.resolution_started_at IS DISTINCT FROM current_hold.resolution_started_at
      OR NEW.resolution_error IS DISTINCT FROM current_hold.resolution_error
      OR NEW.evidence_purged_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'fulfillment hold attempt must exactly archive the locked live evidence';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fulfillment hold attempt evidence is append-only';
  END IF;

  rotation_run := NULLIF(current_setting('daski.protected_data_rotation_run', true), '');
  IF rotation_run IS NOT NULL
    AND EXISTS (SELECT 1 FROM protected_data_rotation_roles WHERE role_name = current_user)
    AND EXISTS (
      SELECT 1 FROM protected_data_rotation_runs
       WHERE id = rotation_run::uuid AND status = 'running'
    )
  THEN
    IF (
      to_jsonb(NEW) - ARRAY[
        'reviewer_edits_encrypted','review_binding_encrypted',
        'adapter_result_encrypted','resolution_error'
      ]::text[]
    ) = (
      to_jsonb(OLD) - ARRAY[
        'reviewer_edits_encrypted','review_binding_encrypted',
        'adapter_result_encrypted','resolution_error'
      ]::text[]
    )
      AND (OLD.reviewer_edits_encrypted IS NULL) = (NEW.reviewer_edits_encrypted IS NULL)
      AND (OLD.review_binding_encrypted IS NULL) = (NEW.review_binding_encrypted IS NULL)
      AND (OLD.adapter_result_encrypted IS NULL) = (NEW.adapter_result_encrypted IS NULL)
      AND (OLD.resolution_error IS NULL) = (NEW.resolution_error IS NULL)
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'protected-data rotation may only replace archived ciphertext';
  END IF;

  IF OLD.evidence_purged_at IS NULL
    AND NEW.evidence_purged_at IS NOT NULL
    AND NEW.reviewer_edits_encrypted IS NULL
    AND NEW.review_binding_encrypted IS NULL
    AND NEW.adapter_result_encrypted IS NULL
    AND NEW.resolution_error IS NULL
    AND (
      to_jsonb(NEW) - ARRAY[
        'reviewer_edits_encrypted','review_binding_encrypted',
        'adapter_result_encrypted','resolution_error','evidence_purged_at'
      ]::text[]
    ) = (
      to_jsonb(OLD) - ARRAY[
        'reviewer_edits_encrypted','review_binding_encrypted',
        'adapter_result_encrypted','resolution_error','evidence_purged_at'
      ]::text[]
    )
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'fulfillment hold attempt evidence is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER fulfillment_hold_attempts_append_only
BEFORE INSERT OR UPDATE OR DELETE ON fulfillment_hold_attempts
FOR EACH ROW EXECUTE FUNCTION prevent_fulfillment_hold_attempt_mutation();

-- Migration 013 makes review/result evidence immutable. A fulfillment hold
-- may run several independently-authorized attempts, so permit only a reset
-- whose complete prior evidence is bound to the next monotonic attempt number.
CREATE OR REPLACE FUNCTION prevent_escalation_evidence_mutation() RETURNS trigger AS $$
DECLARE
  purging BOOLEAN;
  retry_reset BOOLEAN;
  rotation_run TEXT;
BEGIN
  rotation_run := NULLIF(current_setting('daski.protected_data_rotation_run', true), '');
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
  retry_reset := OLD.source = 'fulfillment_hold'
    AND OLD.status IN ('resolution_executing','resolution_result_ready')
    AND NEW.status IN ('pending','resolution_queued')
    AND OLD.fulfillment_attempt_seq < 9223372036854775807
    AND NEW.fulfillment_attempt_seq = OLD.fulfillment_attempt_seq + 1
    AND NEW.transaction_id IS NOT DISTINCT FROM OLD.transaction_id
    AND NEW.resolved_at IS NOT DISTINCT FROM OLD.resolved_at
    AND NEW.resolved_by IS NOT DISTINCT FROM OLD.resolved_by
    AND NEW.adapter_result_encrypted IS NULL
    AND NEW.adapter_result_hash IS NULL
    AND NEW.resolution_started_at IS NULL
    AND NEW.resolution_error IS NULL
    AND (
      (
        NEW.status = 'pending'
        AND NEW.reviewer_decision IS NULL
        AND NEW.reviewer_actor IS NULL
        AND NEW.reviewer_edits_encrypted IS NULL
        AND NEW.reviewer_edits_hash IS NULL
        AND NEW.review_binding_encrypted IS NULL
        AND NEW.review_binding_hash IS NULL
        AND NEW.resolution_claimed_at IS NULL
      ) OR (
        NEW.status = 'resolution_queued'
        AND NEW.reviewer_decision IS NOT DISTINCT FROM OLD.reviewer_decision
        AND NEW.reviewer_actor IS NOT DISTINCT FROM OLD.reviewer_actor
        AND NEW.reviewer_edits_encrypted IS NOT DISTINCT FROM OLD.reviewer_edits_encrypted
        AND NEW.reviewer_edits_hash IS NOT DISTINCT FROM OLD.reviewer_edits_hash
        AND NEW.review_binding_encrypted IS NOT DISTINCT FROM OLD.review_binding_encrypted
        AND NEW.review_binding_hash IS NOT DISTINCT FROM OLD.review_binding_hash
        AND NEW.resolution_claimed_at IS NOT DISTINCT FROM OLD.resolution_claimed_at
      )
    )
    AND EXISTS (
      SELECT 1 FROM fulfillment_hold_attempts a
       WHERE a.escalation_id = OLD.id
         AND a.attempt_seq = NEW.fulfillment_attempt_seq
         AND a.snapshot_service_id IS NOT DISTINCT FROM OLD.snapshot_service_id
         AND a.prior_status = OLD.status
         AND a.next_status = NEW.status
         AND a.fulfillment_supplier IS NOT DISTINCT FROM OLD.fulfillment_supplier
         AND a.fulfillment_hold_kind IS NOT DISTINCT FROM OLD.fulfillment_hold_kind
         AND a.fulfillment_attempts IS NOT DISTINCT FROM OLD.fulfillment_attempts
         AND a.reviewer_decision IS NOT DISTINCT FROM OLD.reviewer_decision
         AND a.reviewer_actor IS NOT DISTINCT FROM OLD.reviewer_actor
         AND (a.reviewer_edits_encrypted IS NULL) = (OLD.reviewer_edits_encrypted IS NULL)
         AND a.reviewer_edits_hash IS NOT DISTINCT FROM OLD.reviewer_edits_hash
         AND (a.review_binding_encrypted IS NULL) = (OLD.review_binding_encrypted IS NULL)
         AND a.review_binding_hash IS NOT DISTINCT FROM OLD.review_binding_hash
         AND (a.adapter_result_encrypted IS NULL) = (OLD.adapter_result_encrypted IS NULL)
         AND a.adapter_result_hash IS NOT DISTINCT FROM OLD.adapter_result_hash
         AND a.resolution_claimed_at IS NOT DISTINCT FROM OLD.resolution_claimed_at
         AND a.resolution_started_at IS NOT DISTINCT FROM OLD.resolution_started_at
         AND (a.resolution_error IS NULL) = (OLD.resolution_error IS NULL)
    );
  IF NEW.fulfillment_attempt_seq IS DISTINCT FROM OLD.fulfillment_attempt_seq
    AND NOT retry_reset
  THEN
    RAISE EXCEPTION 'fulfillment hold attempt sequence requires exact archived evidence';
  END IF;
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
  IF NOT purging AND NOT retry_reset AND OLD.reviewer_decision IS NOT NULL AND (
    NEW.reviewer_decision IS DISTINCT FROM OLD.reviewer_decision OR
    NEW.reviewer_actor IS DISTINCT FROM OLD.reviewer_actor OR
    NEW.reviewer_edits_encrypted IS DISTINCT FROM OLD.reviewer_edits_encrypted OR
    NEW.reviewer_edits_hash IS DISTINCT FROM OLD.reviewer_edits_hash OR
    NEW.review_binding_encrypted IS DISTINCT FROM OLD.review_binding_encrypted OR
    NEW.review_binding_hash IS DISTINCT FROM OLD.review_binding_hash
  ) THEN
    RAISE EXCEPTION 'escalation review authorization is immutable';
  END IF;
  IF NOT purging AND NOT retry_reset AND OLD.adapter_result_encrypted IS NOT NULL AND (
    NEW.adapter_result_encrypted IS DISTINCT FROM OLD.adapter_result_encrypted OR
    NEW.adapter_result_hash IS DISTINCT FROM OLD.adapter_result_hash
  ) THEN
    RAISE EXCEPTION 'escalation adapter result is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

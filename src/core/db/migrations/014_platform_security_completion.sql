-- Final protected-data and durable-dispatch controls from the 2026-07-10
-- security audit. Pre-production rows must be purged before this migration;
-- carrying unbound plaintext into a record-AAD envelope is intentionally
-- unsupported.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM escalations) OR EXISTS (SELECT 1 FROM chat_threads) THEN
    RAISE EXCEPTION 'purge pre-production escalations and chat threads before protected-field migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM supplier_configs
     WHERE notes IS NOT NULL AND notes NOT LIKE 'daski:v1:%'
  ) THEN
    RAISE EXCEPTION 'purge plaintext supplier notes before protected-field migration';
  END IF;
END $$;

ALTER TABLE supplier_configs ADD CONSTRAINT supplier_notes_envelope_check
  CHECK (notes IS NULL OR notes LIKE 'daski:v1:%');

ALTER TABLE assets ADD COLUMN identifier_hash TEXT;
UPDATE assets SET identifier_hash = identifier;
ALTER TABLE assets ALTER COLUMN identifier_hash SET NOT NULL;
DROP INDEX IF EXISTS assets_identifier_idx;
DROP INDEX IF EXISTS assets_live_unique;
CREATE INDEX assets_identifier_hash_idx ON assets(identifier_hash);
CREATE UNIQUE INDEX assets_live_unique
  ON assets(service_id, identifier_hash)
  WHERE status IN ('active','suspended','expired');

ALTER TABLE escalations
  ADD COLUMN operator_dispatch_job_id UUID REFERENCES durable_jobs(id),
  ADD COLUMN legal_hold BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT escalations_question_envelope_check
    CHECK (question LIKE 'daski:v1:%'),
  ADD CONSTRAINT escalations_response_envelope_check
    CHECK (response IS NULL OR response LIKE 'daski:v1:%'),
  ADD CONSTRAINT escalations_recommendation_envelope_check
    CHECK (agent_recommendation IS NULL OR agent_recommendation LIKE 'daski:v1:%'),
  ADD CONSTRAINT escalations_resolution_error_envelope_check
    CHECK (resolution_error IS NULL OR resolution_error LIKE 'daski:v1:%'),
  ADD CONSTRAINT escalations_legacy_edited_data_empty_check
    CHECK (edited_data IS NULL);

ALTER TABLE chat_threads ADD CONSTRAINT chat_threads_title_envelope_check
  CHECK (title IS NULL OR title LIKE 'daski:v1:%');

ALTER TABLE operator_chats
  ADD COLUMN legal_hold BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX operator_chats_retention_idx
  ON operator_chats(created_at)
  WHERE NOT legal_hold;

CREATE TABLE legal_holds (
  id UUID PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('transaction','asset','compliance_case')),
  scope_id TEXT NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 256),
  reason TEXT NOT NULL CHECK (reason LIKE 'daski:v1:%'),
  placed_by TEXT NOT NULL,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_by TEXT,
  released_at TIMESTAMPTZ,
  CONSTRAINT legal_holds_uuid_scope_check CHECK (
    scope_type = 'transaction'
    OR scope_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  )
);
CREATE UNIQUE INDEX legal_holds_one_active_scope
  ON legal_holds(scope_type, scope_id) WHERE released_at IS NULL;

CREATE VIEW active_legal_hold_targets AS
  SELECT id AS hold_id,
         CASE WHEN scope_type = 'transaction' THEN scope_id ELSE NULL END AS transaction_id,
         CASE WHEN scope_type = 'asset' THEN scope_id::uuid ELSE NULL END AS asset_id
    FROM legal_holds
   WHERE released_at IS NULL AND scope_type IN ('transaction','asset')
  UNION ALL
  SELECT h.id, c.transaction_id, c.asset_id
    FROM legal_holds h
    JOIN compliance_cases c ON h.scope_type = 'compliance_case' AND h.scope_id = c.id::text
   WHERE h.released_at IS NULL;

CREATE INDEX escalations_operator_dispatch_idx
  ON escalations(status, created_at)
  WHERE status = 'in_agent_review';

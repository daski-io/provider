-- Human-review metadata lives with the escalation so the operator queue can
-- explain the automation boundary and aggregate repeated observations.
ALTER TABLE escalations
  ADD COLUMN review_kind TEXT,
  ADD COLUMN severity TEXT NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('info', 'warning', 'critical')),
  ADD COLUMN dedupe_key TEXT,
  ADD COLUMN target_type TEXT,
  ADD COLUMN target_id TEXT,
  ADD COLUMN why_human TEXT,
  ADD COLUMN evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN available_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN review_due_at TIMESTAMPTZ,
  ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1
    CHECK (occurrence_count > 0),
  ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX escalations_open_dedupe_key
  ON escalations(dedupe_key)
  WHERE dedupe_key IS NOT NULL
    AND status IN ('pending', 'in_agent_review', 'awaiting_human', 'resolution_attention');

CREATE INDEX escalations_review_queue
  ON escalations(status, severity, review_due_at, last_seen_at DESC)
  WHERE status IN ('pending', 'in_agent_review', 'awaiting_human', 'resolution_attention');

CREATE INDEX escalations_review_target
  ON escalations(target_type, target_id)
  WHERE target_type IS NOT NULL AND target_id IS NOT NULL;

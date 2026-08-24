-- Once-marker for the dead-letter review sweep: a dead-lettered durable job
-- is surfaced as exactly one operator review + platform-log event. Cleared
-- by requeueDeadLetter so a revived job that dead-letters again is surfaced
-- again. Existing dead rows stay NULL on purpose: the first sweep after
-- deploy surfaces them (deduped per queue+key by the review dedupe index).
ALTER TABLE durable_jobs
  ADD COLUMN dead_letter_surfaced_at timestamptz;

CREATE INDEX durable_jobs_dead_letter_unsurfaced
  ON durable_jobs (updated_at)
  WHERE status = 'dead_letter' AND dead_letter_surfaced_at IS NULL;

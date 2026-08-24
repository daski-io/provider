UPDATE escalations
   SET review_kind = COALESCE(
         review_kind,
         CASE
           WHEN source = 'pre_execute' THEN 'pre_execute_resolution'
           WHEN source = 'screening' THEN 'legacy_screening_review'
           ELSE 'legacy_review'
         END
       ),
       dedupe_key = COALESCE(
         dedupe_key,
         CASE
           WHEN source = 'pre_execute' AND transaction_id IS NOT NULL
             THEN 'pre-execute:' || transaction_id
           ELSE 'legacy-review:' || id::text
         END
       ),
       target_type = COALESCE(
         target_type,
         CASE WHEN source = 'pre_execute' THEN 'pre_execute_escalation' ELSE 'escalation' END
       ),
       target_id = COALESCE(target_id, id::text),
       why_human = COALESCE(
         why_human,
         'This historical review requires operator classification before automation continues.'
       ),
       evidence = CASE
         WHEN evidence ? 'version' THEN evidence
         ELSE jsonb_build_object('version', 1, 'classificationRequired', true) || evidence
       END,
       review_due_at = COALESCE(
         review_due_at,
         created_at + CASE severity
           WHEN 'critical' THEN interval '4 hours'
           WHEN 'info' THEN interval '72 hours'
           ELSE interval '24 hours'
         END
       )
 WHERE status IN (
   'pending','in_agent_review','awaiting_human',
   'resolution_queued','rejection_queued','resolution_executing',
   'resolution_result_ready','resolution_attention'
 );

DROP INDEX escalations_open_dedupe_key;
CREATE UNIQUE INDEX escalations_open_dedupe_key
  ON escalations(dedupe_key)
  WHERE dedupe_key IS NOT NULL
    AND status IN (
      'pending','in_agent_review','awaiting_human',
      'resolution_queued','rejection_queued','resolution_executing',
      'resolution_result_ready','resolution_attention'
    );

ALTER TABLE escalations
  ADD CONSTRAINT escalations_open_reviews_typed CHECK (
    status NOT IN (
      'pending','in_agent_review','awaiting_human',
      'resolution_queued','rejection_queued','resolution_executing',
      'resolution_result_ready','resolution_attention'
    )
    OR (
      review_kind IS NOT NULL
      AND dedupe_key IS NOT NULL
      AND target_type IS NOT NULL
      AND target_id IS NOT NULL
      AND why_human IS NOT NULL
      AND evidence ? 'version'
      AND review_due_at IS NOT NULL
    )
  );

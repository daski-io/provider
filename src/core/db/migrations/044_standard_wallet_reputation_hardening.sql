ALTER TABLE standard_asset_rate_buckets
  DROP CONSTRAINT standard_asset_rate_buckets_scope_check;

ALTER TABLE standard_asset_rate_buckets
  ADD CONSTRAINT standard_asset_rate_buckets_scope_check
  CHECK (scope IN ('gateway-signer','payer','provider-action','global'));

ALTER TABLE standard_asset_action_executions
  DROP CONSTRAINT standard_asset_action_result_check;

UPDATE standard_asset_action_executions
   SET sanitized_result=NULL
 WHERE state='completed' AND sanitized_result IS NOT NULL;

ALTER TABLE standard_asset_action_executions
  ADD CONSTRAINT standard_asset_action_result_check CHECK (
    (state = 'completed' AND error_class IS NULL AND sanitized_result IS NULL)
    OR (state = 'failed' AND sanitized_result IS NULL AND error_class IS NOT NULL)
    OR (state NOT IN ('completed','failed') AND sanitized_result IS NULL AND error_class IS NULL)
  );

-- Repair destructive asset actions whose terminal state was not mirrored to
-- their operator-facing transaction. The guarded WHERE clause deliberately
-- leaves already-terminal and still-active transactions untouched.
WITH repaired AS (
  UPDATE transactions t
     SET status = 'canceled',
         metadata = COALESCE(t.metadata, '{}'::jsonb) || jsonb_build_object(
           'asset_action_state', e.state,
           'asset_action_terminal_reason',
             CASE e.state
               WHEN 'canceled' THEN 'wallet_canceled'
               ELSE 'confirmation_expired'
             END
         ),
         updated_at = now(),
         completed_at = COALESCE(t.completed_at, e.updated_at, now()),
         version = t.version + 1
    FROM standard_asset_action_executions e
   WHERE t.standard_action_execution_id = e.execution_id
     AND t.status = 'working'
     AND e.state IN ('canceled', 'expired')
  RETURNING t.id, t.asset_id, t.service_id, e.state
)
INSERT INTO events (
  id,
  transaction_id,
  asset_id,
  service_id,
  source,
  severity,
  type,
  message,
  payload,
  actor
)
SELECT
  gen_random_uuid(),
  id,
  asset_id,
  service_id,
  'system',
  'info',
  'asset_action.' || state,
  CASE state
    WHEN 'canceled' THEN 'Staged asset action canceled by wallet authorization.'
    ELSE 'Staged asset action expired before confirmation.'
  END,
  jsonb_build_object(
    'actionState', state,
    'reason', CASE state
      WHEN 'canceled' THEN 'wallet_canceled'
      ELSE 'confirmation_expired'
    END,
    'transactionStatus', 'canceled',
    'repairedByMigration', true
  ),
  'system:migration:047'
FROM repaired;

-- Bind every durable-job mutation to one unique claim and retire expired
-- claims that have exhausted their retry budget.
ALTER TABLE durable_jobs ADD COLUMN lease_token UUID;

-- Claims created before this migration have no token and therefore cannot be
-- allowed to complete an external effect after the new fencing rules apply.
UPDATE durable_jobs
   SET status = CASE
         WHEN attempts >= max_attempts THEN 'dead_letter'
         ELSE 'retry'
       END,
       available_at = CASE
         WHEN attempts >= max_attempts THEN available_at
         ELSE now()
       END,
       lease_owner = NULL,
       lease_token = NULL,
       lease_expires_at = NULL,
       last_error = COALESCE(last_error, 'claim retired during fencing migration'),
       updated_at = now()
 WHERE status = 'running';

UPDATE durable_jobs
   SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
 WHERE status <> 'running';

ALTER TABLE durable_jobs ADD CONSTRAINT durable_jobs_lease_shape_check CHECK (
  (
    status = 'running'
    AND lease_owner IS NOT NULL
    AND lease_token IS NOT NULL
    AND lease_expires_at IS NOT NULL
  ) OR (
    status <> 'running'
    AND lease_owner IS NULL
    AND lease_token IS NULL
    AND lease_expires_at IS NULL
  )
);

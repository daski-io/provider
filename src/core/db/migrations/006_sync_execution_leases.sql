-- Synchronous execution ownership.
--
-- A claim is admitted with the instance that executes it, a fencing token and
-- an expiring lease that the owner renews while the call runs. Only the token
-- holder can renew or finalize, and only before expiry; once a lease has
-- expired the execution is abandoned and any process applies the documented
-- failure policy. A live call of another process is never touched, so a
-- restart or an overlapping compatible process no longer fails every
-- executing row. The token and owner never change: an abandoned synchronous
-- execution is failed, never taken over.
--
-- Rows executing before this migration (a pre-R1 process) have no lease and
-- stay executing until the operator's stop-and-drain cutover resolves them;
-- nothing is backfilled or invented for them. NOT VALID leaves those rows as
-- they are while every new or updated executing row must carry a lease.
ALTER TABLE provider_transactions
  ADD COLUMN execution_owner UUID,
  ADD COLUMN execution_lease_token UUID,
  ADD COLUMN execution_lease_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT provider_transactions_execution_lease CHECK (
    state <> 'executing'
    OR (execution_owner IS NOT NULL AND execution_lease_token IS NOT NULL
        AND execution_lease_expires_at IS NOT NULL)
  ) NOT VALID;

CREATE INDEX provider_transactions_execution_leases
  ON provider_transactions (execution_lease_expires_at)
  WHERE state = 'executing';

CREATE FUNCTION provider_transactions_execution_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_owner IS DISTINCT FROM OLD.execution_owner
     OR NEW.execution_lease_token IS DISTINCT FROM OLD.execution_lease_token THEN
    RAISE EXCEPTION 'an execution keeps its owner and lease token'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'provider_transactions_execution_owner';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_transactions_execution_owner
  BEFORE UPDATE OF execution_owner, execution_lease_token ON provider_transactions
  FOR EACH ROW EXECUTE FUNCTION provider_transactions_execution_owner();

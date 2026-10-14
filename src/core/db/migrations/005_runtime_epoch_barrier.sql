-- Schema epoch and legacy-process barrier.
--
-- The database declares the schema epoch it requires. Every executable from
-- this release on states the newest epoch it supports in the session setting
-- daski.runtime_epoch on each connection it opens, and refuses to start
-- against an epoch newer than that. Here the database enforces the other
-- direction: every statement that writes a provider table, even one matching
-- no rows, and every read of the migration ledger needs a marker naming at
-- least the schema epoch.
--
-- Executables from before this migration set no marker. Their startup
-- migration read of _migrations fails before their privilege reset, and their
-- unconditional startup sweep fails even when no row is executing, so they can
-- neither boot nor change a row; an old process still running when this
-- commits can no longer write. A future incompatible schema raises the epoch
-- and so excludes older runtimes the same way.
--
-- This is a compatibility control against stale code, not protection from a
-- database credential holder: any session may set the marker. Maintenance
-- sessions (psql, pg_dump --enable-row-security) set it explicitly.
CREATE TABLE provider_schema_epoch (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  epoch INTEGER NOT NULL CHECK (epoch >= 1),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO provider_schema_epoch (epoch) VALUES (1);

-- The marker is checked before the epoch is read, so a session without one
-- gets this error rather than a privilege error. While the epoch row is absent
-- (a logical restore may load it after other tables) any declared epoch is
-- admitted; executables themselves refuse to start without the row.
CREATE FUNCTION provider_runtime_epoch_admitted() RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  marker text := current_setting('daski.runtime_epoch', true);
  required integer;
BEGIN
  IF marker IS NULL OR marker !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'provider compatibility barrier: this session declares no supported runtime epoch'
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Stop pre-R1 provider processes; set daski.runtime_epoch only in reviewed maintenance sessions.';
  END IF;
  SELECT epoch INTO required FROM provider_schema_epoch WHERE singleton;
  IF marker::integer < required THEN
    RAISE EXCEPTION 'provider compatibility barrier: runtime epoch % is older than schema epoch %',
      marker, required
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Run an executable that supports this schema epoch.';
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION provider_runtime_epoch_barrier() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM provider_runtime_epoch_admitted();
  RETURN NULL;
END;
$$;

-- Resolve the epoch table and the check in this schema whatever the caller's
-- search_path (pg_dump, for one, empties it).
DO $$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION provider_runtime_epoch_admitted() SET search_path = %I, pg_temp',
    current_schema()
  );
  EXECUTE format(
    'ALTER FUNCTION provider_runtime_epoch_barrier() SET search_path = %I, pg_temp',
    current_schema()
  );
END;
$$;

-- Statement-level, so the check runs even for an UPDATE or DELETE that
-- matches no rows, and before any row trigger.
CREATE TRIGGER provider_transactions_runtime_epoch
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON provider_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION provider_runtime_epoch_barrier();
CREATE TRIGGER standard_evidence_admissions_runtime_epoch
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON standard_evidence_admissions
  FOR EACH STATEMENT EXECUTE FUNCTION provider_runtime_epoch_barrier();
CREATE TRIGGER supplier_operations_runtime_epoch
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON supplier_operations
  FOR EACH STATEMENT EXECUTE FUNCTION provider_runtime_epoch_barrier();
CREATE TRIGGER rate_limit_buckets_runtime_epoch
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON rate_limit_buckets
  FOR EACH STATEMENT EXECUTE FUNCTION provider_runtime_epoch_barrier();
CREATE TRIGGER provider_runtime_listing_versions_runtime_epoch
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON provider_runtime_listing_versions
  FOR EACH STATEMENT EXECUTE FUNCTION provider_runtime_epoch_barrier();
CREATE TRIGGER provider_quotes_runtime_epoch
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON provider_quotes
  FOR EACH STATEMENT EXECUTE FUNCTION provider_runtime_epoch_barrier();
CREATE TRIGGER provider_schema_epoch_runtime_epoch
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON provider_schema_epoch
  FOR EACH STATEMENT EXECUTE FUNCTION provider_runtime_epoch_barrier();
CREATE TRIGGER _migrations_runtime_epoch
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON _migrations
  FOR EACH STATEMENT EXECUTE FUNCTION provider_runtime_epoch_barrier();

-- The migration runner reads its ledger before anything else, and an old
-- runner does so as the table owner, before it resets privileges. Forced row
-- security makes that first read fail for an unmarked session (superusers,
-- which bypass row security, still meet the statement triggers above).
ALTER TABLE _migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE _migrations FORCE ROW LEVEL SECURITY;
CREATE POLICY _migrations_runtime_epoch ON _migrations
  USING (provider_runtime_epoch_admitted())
  WITH CHECK (provider_runtime_epoch_admitted());

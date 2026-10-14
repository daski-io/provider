-- Async-admission switch and runtime instances.
--
-- External-job admission is off until an operator runs the explicit
-- activation command, which verifies the legacy-process barrier, that no
-- pre-R1 execution is left, that every retained obligation is serviceable,
-- and that every running instance is a compatible external-job worker. No
-- migration, importer or boot turns it on; the runtime role can only read it.
CREATE TABLE provider_async_admission (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled BOOLEAN NOT NULL DEFAULT false,
  changed_at TIMESTAMPTZ,
  -- The verified prerequisite report recorded with the activation.
  evidence JSONB CHECK (evidence IS NULL OR jsonb_typeof(evidence) = 'object'),
  CHECK (NOT enabled OR (changed_at IS NOT NULL AND evidence IS NOT NULL))
);

INSERT INTO provider_async_admission (singleton, enabled) VALUES (true, false);

-- One row per process start: its runtime epoch, build revision and declared
-- capabilities, kept fresh by a heartbeat. Activation reads it to prove that
-- only compatible workers are running; operators read it in the cutover.
CREATE TABLE provider_runtime_instances (
  instance_id UUID PRIMARY KEY,
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch >= 1),
  revision TEXT NOT NULL CHECK (length(revision) BETWEEN 1 AND 128),
  capabilities JSONB NOT NULL CHECK (jsonb_typeof(capabilities) = 'object'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at TIMESTAMPTZ
);

CREATE INDEX provider_runtime_instances_live
  ON provider_runtime_instances (heartbeat_at)
  WHERE stopped_at IS NULL;

CREATE TRIGGER provider_async_admission_runtime_epoch
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON provider_async_admission
  FOR EACH STATEMENT EXECUTE FUNCTION provider_runtime_epoch_barrier();
CREATE TRIGGER provider_runtime_instances_runtime_epoch
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON provider_runtime_instances
  FOR EACH STATEMENT EXECUTE FUNCTION provider_runtime_epoch_barrier();

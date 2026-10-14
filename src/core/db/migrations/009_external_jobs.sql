-- External jobs.
--
-- A funded order of an external-job service is claimed in provider_transactions
-- with its own pending state, 'external_job' (never 'executing', which only
-- synchronous executions use), and in the same transaction one
-- provider_external_jobs row that owns its scheduling and its encrypted
-- recovery material. The job phase is the authoritative progress: queued
-- (public "submitted"), starting, reconciling and polling (public "working"),
-- then completed or failed, written in the transaction that freezes the
-- claim's terminal identity. An overdue marker and a result diagnostic are
-- orthogonal to the phase.
ALTER TABLE provider_transactions DROP CONSTRAINT provider_transactions_state_check;
ALTER TABLE provider_transactions ADD CONSTRAINT provider_transactions_state_check
  CHECK (state IN ('executing', 'external_job', 'completed', 'failed'));
ALTER TABLE provider_transactions DROP CONSTRAINT provider_transactions_check;
ALTER TABLE provider_transactions ADD CONSTRAINT provider_transactions_terminal_shape CHECK (
  (state IN ('executing', 'external_job') AND completed_at IS NULL AND result IS NULL)
  OR (state IN ('completed', 'failed') AND completed_at IS NOT NULL AND result IS NOT NULL)
);
-- An external job is never a synchronous execution: no execution lease.
ALTER TABLE provider_transactions ADD CONSTRAINT provider_transactions_external_job_unleased CHECK (
  state <> 'external_job' OR (execution_owner IS NULL AND execution_lease_token IS NULL
    AND execution_lease_expires_at IS NULL AND result_hash IS NULL)
);

-- Both pending states are admitted, neither turns into the other, and the
-- terminal identity stays frozen exactly as migration 004 defined it.
CREATE OR REPLACE FUNCTION provider_transactions_terminal_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('executing', 'external_job') THEN
      RAISE EXCEPTION 'a claim is admitted as executing or as an external job'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'provider_transactions_terminal_identity';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.gateway_audience IS DISTINCT FROM OLD.gateway_audience
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.dispatch_nonce IS DISTINCT FROM OLD.dispatch_nonce
     OR NEW.dispatch_hash IS DISTINCT FROM OLD.dispatch_hash
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.payer IS DISTINCT FROM OLD.payer
     OR NEW.service_slug IS DISTINCT FROM OLD.service_slug
     OR NEW.skill_id IS DISTINCT FROM OLD.skill_id
     OR NEW.listing_manifest_hash IS DISTINCT FROM OLD.listing_manifest_hash
     OR NEW.dispatch_valid_before IS DISTINCT FROM OLD.dispatch_valid_before
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an admitted claim keeps its bindings'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'provider_transactions_claim_binding';
  END IF;
  IF OLD.state NOT IN ('executing', 'external_job') THEN
    IF NEW.state IS DISTINCT FROM OLD.state
       OR NEW.result IS DISTINCT FROM OLD.result
       OR NEW.result_hash IS DISTINCT FROM OLD.result_hash
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
      RAISE EXCEPTION 'a terminal task identity is frozen'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'provider_transactions_terminal_identity';
    END IF;
  ELSIF NEW.state IN ('executing', 'external_job') THEN
    IF NEW.state <> OLD.state THEN
      RAISE EXCEPTION 'a pending claim keeps its execution mode'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'provider_transactions_execution_mode';
    END IF;
  ELSIF NEW.result_hash IS NULL THEN
    RAISE EXCEPTION 'a terminal transition must freeze its result hash'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'provider_transactions_terminal_identity';
  END IF;
  RETURN NEW;
END;
$$;

-- One row per external-job claim. Task, order, audience, request, listing
-- version and dispatch binding are the claim's, referenced immutably. The
-- input, the upstream job reference and an invalid result candidate are
-- stored only as authenticated envelopes (daski:v1, src/core/security/
-- fieldEncryption.ts) with the key id each names, and are cleared when the
-- job finishes. Leases fence every write; the lease is held only during a
-- bounded call and released between calls.
CREATE TABLE provider_external_jobs (
  task_id TEXT PRIMARY KEY REFERENCES provider_transactions (id),
  execution_mode TEXT NOT NULL DEFAULT 'external-job' CHECK (execution_mode = 'external-job'),
  adapter_version TEXT NOT NULL CHECK (adapter_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  journal_operation_id UUID UNIQUE REFERENCES supplier_operations (id),
  input_ciphertext TEXT CHECK (input_ciphertext IS NULL OR input_ciphertext LIKE 'daski:v1:%'),
  input_key_id TEXT CHECK (input_key_id IS NULL OR input_key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  job_reference_ciphertext TEXT
    CHECK (job_reference_ciphertext IS NULL OR job_reference_ciphertext LIKE 'daski:v1:%'),
  job_reference_key_id TEXT
    CHECK (job_reference_key_id IS NULL OR job_reference_key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  result_candidate_ciphertext TEXT
    CHECK (result_candidate_ciphertext IS NULL OR result_candidate_ciphertext LIKE 'daski:v1:%'),
  result_candidate_key_id TEXT
    CHECK (result_candidate_key_id IS NULL OR result_candidate_key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  result_diagnostic TEXT CHECK (result_diagnostic IS NULL OR result_diagnostic ~ '^[a-z][a-z0-9_]{1,63}$'),
  phase TEXT NOT NULL DEFAULT 'queued'
    CHECK (phase IN ('queued', 'starting', 'reconciling', 'polling', 'completed', 'failed')),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  lease_owner UUID,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fulfillment_deadline TIMESTAMPTZ NOT NULL,
  first_start_attempt_at TIMESTAMPTZ,
  idempotency_valid_before TIMESTAMPTZ,
  overdue_at TIMESTAMPTZ,
  last_progress_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  start_attempts INTEGER NOT NULL DEFAULT 0 CHECK (start_attempts >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  reconciliation_count INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_count >= 0),
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_.]{1,63}$'),
  result_hash BYTEA CHECK (result_hash IS NULL OR octet_length(result_hash) = 32),
  finished_at TIMESTAMPTZ,
  CHECK ((input_ciphertext IS NULL) = (input_key_id IS NULL)),
  CHECK ((job_reference_ciphertext IS NULL) = (job_reference_key_id IS NULL)),
  CHECK ((result_candidate_ciphertext IS NULL) = (result_candidate_key_id IS NULL)),
  CHECK ((lease_token IS NULL) = (lease_owner IS NULL)
    AND (lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (fulfillment_deadline > accepted_at),
  CHECK (first_start_attempt_at IS NOT NULL OR (idempotency_valid_before IS NULL AND start_attempts = 0)),
  CHECK (phase <> 'starting' OR (first_start_attempt_at IS NOT NULL AND lease_token IS NOT NULL)),
  CHECK (phase <> 'polling' OR job_reference_ciphertext IS NOT NULL),
  CHECK (
    (phase IN ('queued', 'starting', 'reconciling', 'polling')
      AND input_ciphertext IS NOT NULL AND result_hash IS NULL AND finished_at IS NULL)
    OR (phase IN ('completed', 'failed')
      AND input_ciphertext IS NULL AND job_reference_ciphertext IS NULL
      AND result_candidate_ciphertext IS NULL AND result_diagnostic IS NULL
      AND lease_token IS NULL AND result_hash IS NOT NULL AND finished_at IS NOT NULL)
  )
);

CREATE INDEX provider_external_jobs_due
  ON provider_external_jobs (next_run_at)
  WHERE phase IN ('queued', 'starting', 'reconciling', 'polling');

-- Admission facts, the start horizon, the linked journal, the overdue marker
-- and the job reference never change once recorded; each write raises the
-- revision; phases move only along the reviewed transitions; a queued job
-- can fail only once its deadline passed and if no start was ever
-- attempted; and a finished job matches its frozen claim and changes no
-- more.
CREATE FUNCTION provider_external_jobs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.phase <> 'queued' OR NEW.revision <> 0 OR NEW.first_start_attempt_at IS NOT NULL
       OR NEW.journal_operation_id IS NOT NULL OR NEW.job_reference_ciphertext IS NOT NULL
       OR NEW.result_candidate_ciphertext IS NOT NULL OR NEW.lease_token IS NOT NULL
       OR NEW.overdue_at IS NOT NULL THEN
      RAISE EXCEPTION 'an external job is admitted queued'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_external_jobs_admission';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM provider_transactions
                    WHERE id = NEW.task_id AND state = 'external_job') THEN
      RAISE EXCEPTION 'an external job belongs to a pending external-job claim'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_external_jobs_admission';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.phase IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'a finished external job is frozen'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_external_jobs_frozen';
  END IF;
  IF NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.execution_mode IS DISTINCT FROM OLD.execution_mode
     OR NEW.adapter_version IS DISTINCT FROM OLD.adapter_version
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
     OR NEW.fulfillment_deadline IS DISTINCT FROM OLD.fulfillment_deadline
     OR NEW.revision <= OLD.revision
     OR (OLD.first_start_attempt_at IS NOT NULL
         AND (NEW.first_start_attempt_at IS DISTINCT FROM OLD.first_start_attempt_at
              OR NEW.idempotency_valid_before IS DISTINCT FROM OLD.idempotency_valid_before))
     OR (OLD.journal_operation_id IS NOT NULL
         AND NEW.journal_operation_id IS DISTINCT FROM OLD.journal_operation_id)
     OR (OLD.overdue_at IS NOT NULL AND NEW.overdue_at IS DISTINCT FROM OLD.overdue_at)
     OR (NEW.phase NOT IN ('completed', 'failed')
         AND (NEW.input_ciphertext IS DISTINCT FROM OLD.input_ciphertext
              OR (OLD.job_reference_ciphertext IS NOT NULL
                  AND NEW.job_reference_ciphertext IS DISTINCT FROM OLD.job_reference_ciphertext))) THEN
    RAISE EXCEPTION 'an external job keeps its admission, start horizon, journal and job reference'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_external_jobs_identity';
  END IF;
  IF NEW.phase IS DISTINCT FROM OLD.phase AND NOT (
       (OLD.phase = 'queued' AND NEW.phase = 'starting')
    OR (OLD.phase = 'queued' AND NEW.phase = 'failed' AND NEW.first_start_attempt_at IS NULL
        AND now() >= OLD.fulfillment_deadline)
    OR (OLD.phase IN ('starting', 'reconciling')
        AND NEW.phase IN ('reconciling', 'polling', 'completed', 'failed'))
    OR (OLD.phase = 'reconciling' AND NEW.phase = 'starting')
    OR (OLD.phase = 'polling' AND NEW.phase IN ('completed', 'failed'))
  ) THEN
    RAISE EXCEPTION 'external job phase % cannot become %', OLD.phase, NEW.phase
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_external_jobs_phase';
  END IF;
  IF NEW.phase IN ('completed', 'failed') AND NOT EXISTS (
       SELECT 1 FROM provider_transactions t
        WHERE t.id = NEW.task_id AND t.state = NEW.phase AND t.result_hash = NEW.result_hash) THEN
    RAISE EXCEPTION 'a finished external job matches its frozen claim'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_external_jobs_frozen';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_external_jobs_guard
  BEFORE INSERT OR UPDATE ON provider_external_jobs
  FOR EACH ROW EXECUTE FUNCTION provider_external_jobs_guard();

-- At commit, an external-job claim has its job, and a claim that left
-- 'external_job' left it together with its job.
CREATE FUNCTION provider_transactions_external_job() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM provider_external_jobs j
        WHERE j.task_id = NEW.id
          AND ((NEW.state = 'external_job'
                AND j.phase IN ('queued', 'starting', 'reconciling', 'polling'))
               OR j.phase = NEW.state)) THEN
    RAISE EXCEPTION 'an external-job claim and its job change together'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'provider_transactions_external_job';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER provider_transactions_external_job_admitted
  AFTER INSERT ON provider_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.state = 'external_job')
  EXECUTE FUNCTION provider_transactions_external_job();
CREATE CONSTRAINT TRIGGER provider_transactions_external_job_finished
  AFTER UPDATE ON provider_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.state = 'external_job')
  EXECUTE FUNCTION provider_transactions_external_job();

-- Core's start journal for a job confirms by naming the job row that holds
-- the encrypted job reference; it never stores the reference itself.
ALTER TABLE supplier_operations
  ADD COLUMN external_job_task_id TEXT REFERENCES provider_external_jobs (task_id),
  ADD CONSTRAINT supplier_operations_external_job_reference CHECK (
    external_job_task_id IS NULL OR (state = 'confirmed' AND result IS NULL)
  );

-- The worker's own heartbeat, apart from the process heartbeat, so a stopped
-- worker is told apart from a healthy one waiting on a slow upstream job.
ALTER TABLE provider_runtime_instances ADD COLUMN worker_heartbeat_at TIMESTAMPTZ;

CREATE TRIGGER provider_external_jobs_runtime_epoch
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON provider_external_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION provider_runtime_epoch_barrier();

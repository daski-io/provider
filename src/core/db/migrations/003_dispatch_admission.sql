-- Dispatch admission fence and the persisted operations projection.
--
-- A new claim records its signed dispatch envelope's validBefore, and a
-- deferred constraint trigger refuses to commit it at or after that instant,
-- however slowly the admission transaction ran. After a no-claim status
-- answer the gateway waits validBefore + 60 seconds before it replaces an
-- ambiguous dispatch, so no claim can appear behind that answer. Rows that
-- predate this migration keep a NULL deadline; only inserts are fenced.
ALTER TABLE provider_transactions
  ADD COLUMN dispatch_valid_before TIMESTAMPTZ,
  ADD COLUMN operations_revision INTEGER NOT NULL DEFAULT 0
    CHECK (operations_revision >= 0),
  ADD COLUMN operations_projection JSONB NOT NULL
    DEFAULT '{"fulfillment": null, "recovery": null, "support": null}'::jsonb
    CHECK (
      jsonb_typeof(operations_projection) = 'object'
      AND operations_projection ?& ARRAY['fulfillment', 'recovery', 'support']
      AND operations_projection - ARRAY['fulfillment', 'recovery', 'support'] = '{}'::jsonb
    );

CREATE FUNCTION provider_transactions_admission_deadline() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.dispatch_valid_before IS NULL
     OR clock_timestamp() >= NEW.dispatch_valid_before THEN
    RAISE EXCEPTION 'dispatch admission deadline elapsed'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'provider_transactions_admission_deadline';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER provider_transactions_admission_deadline
  AFTER INSERT ON provider_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION provider_transactions_admission_deadline();

-- One operations revision names exactly one semantic projection (observedAt
-- excluded): a revision never decreases, and changed content needs a higher
-- revision. A constant all-null projection keeps revision 0 forever.
CREATE FUNCTION provider_transactions_operations_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operations_revision < OLD.operations_revision
     OR (NEW.operations_revision = OLD.operations_revision
         AND NEW.operations_projection IS DISTINCT FROM OLD.operations_projection) THEN
    RAISE EXCEPTION 'operations revision must identify exactly one projection'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'provider_transactions_operations_revision';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_transactions_operations_revision
  BEFORE UPDATE OF operations_revision, operations_projection ON provider_transactions
  FOR EACH ROW EXECUTE FUNCTION provider_transactions_operations_revision();

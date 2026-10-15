-- The adapter version that sold each quote.
--
-- An external-job order is run by the adapter version that sold it, even when
-- it is first dispatched after new sales moved to another version: a newer
-- version may read job references or map reports differently, while the
-- order's result is held to the contract of the listing version it was paid
-- under. A quote records that version when it is issued (local execution
-- metadata, never part of the signed quote), admission selects it among the
-- current and retained adapters, and boot, the importer and activation
-- require it while the quote may still be dispatched. A quote without one was
-- sold by a synchronous adapter or recorded before this migration; its order
-- runs with the service's current adapter. A recorded version never changes.
--
-- Part of the R1 release with migrations 005 to 009, at schema epoch 1.
ALTER TABLE provider_quotes
  ADD COLUMN adapter_version TEXT
    CHECK (adapter_version IS NULL OR adapter_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');

CREATE FUNCTION provider_quotes_adapter_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.adapter_version IS DISTINCT FROM OLD.adapter_version THEN
    RAISE EXCEPTION 'a provider quote keeps the adapter version that sold it'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'provider_quotes_adapter_version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_quotes_adapter_version
  BEFORE UPDATE OF adapter_version ON provider_quotes
  FOR EACH ROW EXECUTE FUNCTION provider_quotes_adapter_version();

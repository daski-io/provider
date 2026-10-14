-- Frozen terminal identity.
--
-- Every terminal attestation of a task, dispatch and lifecycle alike, must
-- carry the same state, result hash and completion time forever. A claim is
-- admitted as 'executing'; the transition out of it writes the state, the
-- result, its canonical hash and the completion time together, and nothing
-- changes them afterwards. The admitted bindings of a claim never change
-- either.
--
-- Rows that became terminal before this migration keep a NULL hash: their
-- identity is the canonical hash of the stored result exactly as it was
-- attested, and they are never rewritten or reshaped.
ALTER TABLE provider_transactions
  ADD COLUMN result_hash BYTEA
    CHECK (result_hash IS NULL OR octet_length(result_hash) = 32),
  ADD CONSTRAINT provider_transactions_pending_unhashed
    CHECK (state <> 'executing' OR result_hash IS NULL);

CREATE FUNCTION provider_transactions_terminal_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'executing' THEN
      RAISE EXCEPTION 'a claim is admitted as executing'
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
  IF OLD.state <> 'executing' THEN
    IF NEW.state IS DISTINCT FROM OLD.state
       OR NEW.result IS DISTINCT FROM OLD.result
       OR NEW.result_hash IS DISTINCT FROM OLD.result_hash
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
      RAISE EXCEPTION 'a terminal task identity is frozen'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'provider_transactions_terminal_identity';
    END IF;
  ELSIF NEW.state <> 'executing' AND NEW.result_hash IS NULL THEN
    RAISE EXCEPTION 'a terminal transition must freeze its result hash'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'provider_transactions_terminal_identity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_transactions_terminal_identity
  BEFORE INSERT OR UPDATE ON provider_transactions
  FOR EACH ROW EXECUTE FUNCTION provider_transactions_terminal_identity();

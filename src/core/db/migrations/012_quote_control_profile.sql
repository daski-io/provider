-- The provider control profile each quote was issued under.
--
-- The gateway dispatches every order with the control-profile hash its
-- checkout snapshot committed, even after the provider's profile changed and
-- long after the quote expired. A quote records the profile it was issued
-- under (local metadata, never part of the signed quote), so boot, the
-- importer, activation and the doctor can name a profile its order may still
-- carry that this build no longer accepts. A quote without one was issued
-- before this migration. A recorded profile never changes.
--
-- Part of the R1 release with migrations 005 to 011, at schema epoch 1.
ALTER TABLE provider_quotes
  ADD COLUMN provider_control_profile_hash BYTEA
    CHECK (provider_control_profile_hash IS NULL OR octet_length(provider_control_profile_hash) = 32);

CREATE FUNCTION provider_quotes_control_profile() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_control_profile_hash IS DISTINCT FROM OLD.provider_control_profile_hash THEN
    RAISE EXCEPTION 'a provider quote keeps the control profile it was issued under'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'provider_quotes_control_profile';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_quotes_control_profile
  BEFORE UPDATE OF provider_control_profile_hash ON provider_quotes
  FOR EACH ROW EXECUTE FUNCTION provider_quotes_control_profile();

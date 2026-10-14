-- Provider-quote retention.
--
-- A quote can back a dispatch long after it expires: the gateway re-dispatches
-- a timely-paid order until its first release observation plus the order
-- snapshot's fulfillment window. A quote is therefore kept while it may still
-- back a first dispatch (retain_until: its validBefore plus its listing
-- version's fulfillment window plus a margin, recorded when it is issued) and
-- forever once a claim names it. Rows from before this migration have no
-- retain_until and are kept.
ALTER TABLE provider_quotes
  ADD COLUMN retain_until TIMESTAMPTZ;

-- The provider quote a claim was admitted against; it never changes. Claims
-- from before this migration bound no persisted quote.
ALTER TABLE provider_transactions
  ADD COLUMN provider_quote_hash BYTEA
    CHECK (provider_quote_hash IS NULL OR octet_length(provider_quote_hash) = 32);

CREATE INDEX provider_transactions_provider_quote
  ON provider_transactions (provider_quote_hash)
  WHERE provider_quote_hash IS NOT NULL;

CREATE FUNCTION provider_transactions_quote_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_quote_hash IS DISTINCT FROM OLD.provider_quote_hash THEN
    RAISE EXCEPTION 'an admitted claim keeps its provider quote'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'provider_transactions_quote_binding';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_transactions_quote_binding
  BEFORE UPDATE OF provider_quote_hash ON provider_transactions
  FOR EACH ROW EXECUTE FUNCTION provider_transactions_quote_binding();

-- Whoever deletes, only a quote past its retention that no claim names goes.
CREATE FUNCTION provider_quotes_retention() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.retain_until IS NULL OR OLD.retain_until >= now()
     OR EXISTS (SELECT 1 FROM provider_transactions
                 WHERE provider_quote_hash = OLD.quote_hash) THEN
    RAISE EXCEPTION 'a provider quote is retained while it may back a dispatch'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'provider_quotes_retention';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER provider_quotes_retention
  BEFORE DELETE ON provider_quotes
  FOR EACH ROW EXECUTE FUNCTION provider_quotes_retention();

-- Provider quotes are kept for the protocol's first-dispatch bound.
--
-- The gateway never signs a new dispatch for an order more than 30 days
-- (MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS) after its QuoteV1's validBefore,
-- and the provider refuses a new claim from a dispatch issued later. The
-- QuoteV1 never outlives the provider quote it names, and a dispatch
-- envelope lives at most one day, so no new claim can name a provider quote
-- once its own validBefore plus 31 days (2,678,400 seconds) has passed.
-- Until then the quote stays an obligation; after it, a quote that no claim
-- names may be deleted, whoever deletes. This replaces 011, which refused
-- every quote deletion.
--
-- Part of the R1 release with migrations 005 to 013, at schema epoch 1.
CREATE OR REPLACE FUNCTION provider_quotes_retention() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.valid_before + 2678400 >= extract(epoch FROM now())
     OR EXISTS (SELECT 1 FROM provider_transactions
                 WHERE provider_quote_hash = OLD.quote_hash) THEN
    RAISE EXCEPTION 'a provider quote is retained while a dispatch may still name it'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'provider_quotes_retention';
  END IF;
  RETURN OLD;
END;
$$;

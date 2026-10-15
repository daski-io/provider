-- Provider quotes are kept until the gateway can prove no dispatch will name
-- them.
--
-- 007 let an unclaimed quote go at its validBefore plus its listing version's
-- fulfillment window plus 30 days. The gateway's first-dispatch window starts
-- at its first release observation, not at the quote's expiry, and no
-- protocol bound places that observation within any margin: a timely-paid
-- order can be dispatched for the first time after a guessed retention ended.
-- Until a verified gateway obligation inventory exists, every quote is an
-- obligation: no quote is ever deleted, whoever deletes, and the guessed
-- retention is dropped.
--
-- Part of the R1 release with migrations 005 to 010, at schema epoch 1.
CREATE OR REPLACE FUNCTION provider_quotes_retention() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a provider quote is retained while a dispatch may still name it'
    USING ERRCODE = 'check_violation',
          CONSTRAINT = 'provider_quotes_retention';
END;
$$;

ALTER TABLE provider_quotes DROP COLUMN retain_until;

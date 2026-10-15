-- The supplier-cost ceiling each quote records.
--
-- A service that pays a supplier reports, at quote time, the supplier's
-- current price for the request. The quote records it, with the supplier
-- price tolerance in force (SUPPLIER_PRICE_TOLERANCE_PERCENT), as
-- supplier-cost-ceiling-v2 (local metadata, never part of the signed quote).
-- The order's adapter reads it through its claim's provider quote and spends
-- at most quotedAmount * (100 + tolerancePercent) / 100 at that supplier, in
-- that currency. The column admits exactly a valid v2 ceiling, or none: a
-- service that spends nothing at a supplier, or a quote issued before this
-- migration. A recorded ceiling never changes.
--
-- Part of the R1 release with migrations 005 to 012, at schema epoch 1.
ALTER TABLE provider_quotes
  ADD COLUMN supplier_cost_ceiling JSONB
    CHECK (supplier_cost_ceiling IS NULL OR (
      jsonb_typeof(supplier_cost_ceiling) = 'object'
      AND supplier_cost_ceiling ?& ARRAY['kind', 'supplier', 'currency', 'quotedAmount', 'tolerancePercent']
      AND supplier_cost_ceiling
        - ARRAY['kind', 'supplier', 'currency', 'quotedAmount', 'tolerancePercent'] = '{}'::jsonb
      AND supplier_cost_ceiling->>'kind' = 'supplier-cost-ceiling-v2'
      AND jsonb_typeof(supplier_cost_ceiling->'supplier') = 'string'
      AND supplier_cost_ceiling->>'supplier' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
      AND jsonb_typeof(supplier_cost_ceiling->'currency') = 'string'
      AND supplier_cost_ceiling->>'currency' ~ '^[A-Z][A-Z0-9]{2,11}$'
      AND jsonb_typeof(supplier_cost_ceiling->'quotedAmount') = 'string'
      AND supplier_cost_ceiling->>'quotedAmount' ~ '^(0|[1-9][0-9]{0,29})([.][0-9]{1,18})?$'
      AND jsonb_typeof(supplier_cost_ceiling->'tolerancePercent') = 'string'
      -- 0 to 100 with at most two decimals ('100.5' is not a tolerance).
      AND supplier_cost_ceiling->>'tolerancePercent'
        ~ '^((0|[1-9][0-9]?)([.][0-9]{1,2})?|100([.]00?)?)$'
    ));

CREATE FUNCTION provider_quotes_supplier_cost_ceiling() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.supplier_cost_ceiling IS DISTINCT FROM OLD.supplier_cost_ceiling THEN
    RAISE EXCEPTION 'a provider quote keeps the supplier-cost ceiling it was issued with'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'provider_quotes_supplier_cost_ceiling';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_quotes_supplier_cost_ceiling
  BEFORE UPDATE OF supplier_cost_ceiling ON provider_quotes
  FOR EACH ROW EXECUTE FUNCTION provider_quotes_supplier_cost_ceiling();

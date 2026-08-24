-- Backfill buyers.last_known_email from the most-recent
-- transactions.contact_email per buyer. Producer for the column was
-- missing in v4: upsertBuyer accepted an `email` arg but no callsite
-- passed it, so the Buyers admin page rendered every row as "—" even
-- when transactions.contact_email was populated. The settlement
-- handler now writes through, but this fixes existing rows so the UI
-- isn't lying about historical buyers.
--
-- Only fills NULLs — never overwrites an address an operator may have
-- corrected manually. DISTINCT ON picks the newest contact_email per
-- buyer (ORDER BY created_at DESC).

UPDATE buyers b
   SET last_known_email = sub.contact_email
  FROM (
    SELECT DISTINCT ON (t.buyer_id)
           t.buyer_id,
           t.contact_email
      FROM transactions t
     WHERE t.contact_email IS NOT NULL
     ORDER BY t.buyer_id, t.created_at DESC
  ) sub
 WHERE sub.buyer_id = b.id
   AND b.last_known_email IS NULL;

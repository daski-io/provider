import { pool } from "./pool.js";
import { inTransaction } from "./queryable.js";

export async function purgeExpiredEphemeralTransactions(): Promise<number> {
  return inTransaction(pool, async (db) => {
    const candidates = await db.query<{ id: string }>(
      `SELECT t.id
         FROM transactions t
        WHERE t.retention_class = 'ephemeral'
          AND t.expires_at < now()
          AND t.status IN ('completed','failed','canceled')
          AND t.asset_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM active_legal_hold_targets h
             WHERE h.transaction_id = t.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM events e
             WHERE e.transaction_id = t.id AND e.legal_hold
          )
          AND NOT EXISTS (SELECT 1 FROM escalations e WHERE e.transaction_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM emails_inbound e WHERE e.transaction_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM emails_outbound e WHERE e.transaction_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM artifact_secrets a WHERE a.transaction_id = t.id)
          AND NOT EXISTS (
            SELECT 1 FROM standard_reputation_outcomes r WHERE r.transaction_id = t.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM compliance_cases c WHERE c.transaction_id = t.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM supplier_operations s WHERE s.transaction_id = t.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM supplier_breaker_failures s WHERE s.transaction_id = t.id
          )
        ORDER BY t.expires_at
        LIMIT 500
        FOR UPDATE OF t SKIP LOCKED`,
    );
    const ids = candidates.rows.map((row) => row.id);
    if (ids.length === 0) return 0;
    await db.query(
      `DELETE FROM push_subscriptions WHERE transaction_id = ANY($1::text[])`,
      [ids],
    );
    await db.query(
      `DELETE FROM events WHERE transaction_id = ANY($1::text[])`,
      [ids],
    );
    const deleted = await db.query(
      `DELETE FROM transactions
        WHERE id = ANY($1::text[])
          AND retention_class = 'ephemeral'`,
      [ids],
    );
    return deleted.rowCount ?? 0;
  });
}

import { pool } from "../db/pool.js";
import type { Queryable } from "../db/queryable.js";

// Platform-wide compliance blocklist (spec S9 / core change 6). A confirmed
// sanctions match freezes the wallet across ALL services, and every paid
// skill handler checks the list at
// task creation — before idempotency/adapter work.
//
// Under x402 the payment is already settled by the time the provider sees
// the request (L10), so "refuse" cannot mean "refund": a blocked identity's
// settled payment is recorded, flagged `compliance_blocked`, escalated for
// funds disposition — and never executed, never refunded. Pre-settlement
// refusal is a gateway workstream, not provider machinery.
//
// Rows are soft-removed (removed_at/removed_by) so add/remove stays a
// logged, deliberate operator action.

export interface BlockedIdentityRow {
  id: string;
  wallet_address: string | null;
  reason: string;
  created_by: string;
  created_at: Date;
  removed_at: Date | null;
  removed_by: string | null;
}

export async function findActiveBlock(args: {
  walletAddress?: string | null;
}, db: Queryable = pool): Promise<BlockedIdentityRow | null> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (args.walletAddress) {
    params.push(args.walletAddress.toLowerCase());
    clauses.push(`lower(wallet_address) = $${params.length}`);
  }
  if (clauses.length === 0) return null;
  const result = await db.query(
    `SELECT * FROM blocked_identities
      WHERE removed_at IS NULL AND (${clauses.join(" OR ")})
      ORDER BY created_at
      LIMIT 1`,
    params,
  );
  return (result.rows[0] as BlockedIdentityRow | undefined) ?? null;
}

export async function listBlockedIdentities(
  includeRemoved = false,
): Promise<BlockedIdentityRow[]> {
  const result = await pool.query(
    `SELECT * FROM blocked_identities
      ${includeRemoved ? "" : "WHERE removed_at IS NULL"}
      ORDER BY created_at DESC`,
  );
  return result.rows as BlockedIdentityRow[];
}

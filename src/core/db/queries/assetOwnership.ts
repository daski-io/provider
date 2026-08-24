import { pool } from "../pool.js";
import { revealAssetIdentifierValue } from "./assets.js";

export interface StandardPayerAssetRow {
  id: string;
  service_slug: string;
  type: string;
  identifier: string;
  status: string;
  created_at: Date;
  created_at_cursor: string;
  expires_at: Date | null;
}

interface StoredStandardPayerAssetRow extends StandardPayerAssetRow {
  has_more: boolean;
}

export async function listAssetsForStandardPayer(args: {
  payer: string;
  limit: number;
  after?: { createdAt: string; id: string };
}): Promise<{ assets: StandardPayerAssetRow[]; hasMore: boolean }> {
  const result = await pool.query<StoredStandardPayerAssetRow>(
    `SELECT a.id, s.slug AS service_slug, a.type, a.identifier, a.status,
            a.created_at, a.created_at::text AS created_at_cursor,
            a.expires_at, count(*) OVER () > $2 AS has_more
       FROM assets a
       JOIN services s ON s.id = a.service_id
       JOIN LATERAL (
         SELECT t.standard_payer
           FROM transactions t
          WHERE t.asset_id = a.id
            AND t.standard_order_id IS NOT NULL
            AND t.standard_payer IS NOT NULL
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT 1
       ) ownership ON true
      WHERE lower(ownership.standard_payer) = lower($1)
        AND ($3::timestamptz IS NULL OR (a.created_at, a.id) < ($3, $4::uuid))
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $2`,
    [args.payer, args.limit + 1, args.after?.createdAt ?? null, args.after?.id ?? null],
  );
  const page = result.rows.slice(0, args.limit);
  return {
    assets: page.map((row) => ({
      id: row.id,
      service_slug: row.service_slug,
      type: row.type,
      identifier: revealAssetIdentifierValue(row.id, row.type, row.identifier),
      status: row.status,
      created_at: row.created_at,
      created_at_cursor: row.created_at_cursor,
      expires_at: row.expires_at,
    })),
    hasMore: result.rows.length > args.limit,
  };
}

export async function getStandardPayerAsset(args: {
  payer: string;
  providerAssetId: string;
}): Promise<StandardPayerAssetRow | null> {
  const result = await pool.query<StoredStandardPayerAssetRow>(
    `SELECT a.id, s.slug AS service_slug, a.type, a.identifier, a.status,
            a.created_at, a.created_at::text AS created_at_cursor,
            a.expires_at, false AS has_more
       FROM assets a
       JOIN services s ON s.id = a.service_id
       JOIN LATERAL (
         SELECT t.standard_payer
           FROM transactions t
          WHERE t.asset_id = a.id
            AND t.standard_order_id IS NOT NULL
            AND t.standard_payer IS NOT NULL
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT 1
       ) ownership ON true
      WHERE a.id = $1::uuid AND lower(ownership.standard_payer) = lower($2)`,
    [args.providerAssetId, args.payer],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    service_slug: row.service_slug,
    type: row.type,
    identifier: revealAssetIdentifierValue(row.id, row.type, row.identifier),
    status: row.status,
    created_at: row.created_at,
    created_at_cursor: row.created_at_cursor,
    expires_at: row.expires_at,
  } : null;
}

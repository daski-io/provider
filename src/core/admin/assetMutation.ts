import { pool } from "../db/pool.js";
import { inTransaction } from "../db/queryable.js";
import type { AssetStatus } from "../db/queries/assets.js";
import { recordMandatoryAudit } from "../events/emitter.js";

/** Commit a service-owned admin asset mutation and its audit as one unit. */
export async function commitAdminAssetMutation(args: {
  assetId: string;
  serviceId: string;
  actor: string;
  expectedStatus?: AssetStatus;
  status?: AssetStatus;
  metadataPatch?: Record<string, unknown>;
  event: {
    type: string;
    message: string;
    severity?: "debug" | "info" | "warn" | "error";
    payload?: unknown;
  };
}): Promise<void> {
  await inTransaction(pool, async (db) => {
    const result = await db.query(
      `UPDATE assets
          SET status = COALESCE($2::text, status),
              metadata = metadata || $3::jsonb
        WHERE id = $1
          AND ($4::text IS NULL OR status = $4)
        RETURNING id`,
      [
        args.assetId,
        args.status ?? null,
        JSON.stringify(args.metadataPatch ?? {}),
        args.expectedStatus ?? null,
      ],
    );
    if (result.rows.length !== 1) {
      throw new Error(`Asset '${args.assetId}' changed before the admin action completed`);
    }
    await recordMandatoryAudit(db, {
      assetId: args.assetId,
      serviceId: args.serviceId,
      source: "admin",
      severity: args.event.severity,
      type: args.event.type,
      actor: args.actor,
      message: args.event.message,
      payload: args.event.payload,
    });
  });
}

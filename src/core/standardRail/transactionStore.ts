import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import type { ServiceResult } from "../serviceRegistry/types.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

export interface ProviderTransaction {
  id: string;
  gateway_audience: string;
  order_id: string;
  dispatch_hash: Buffer;
  payer: Hex;
  service_slug: string;
  skill_id: string;
  state: "executing" | "completed" | "failed";
  result: ServiceResult | null;
  created_at: Date;
  completed_at: Date | null;
}

export async function findTransaction(
  gatewayAudience: string,
  orderId: string,
): Promise<ProviderTransaction | null> {
  const result = await pool.query<ProviderTransaction>(
    "SELECT * FROM provider_transactions WHERE gateway_audience=$1 AND order_id=$2",
    [gatewayAudience, orderId],
  );
  return result.rows[0] ?? null;
}

export async function claimTransaction(args: {
  gatewayAudience: string;
  orderId: string;
  dispatchNonce: Hex;
  dispatchHash: Hex;
  requestHash: Hex;
  payer: Hex;
  serviceSlug: string;
  skillId: string;
  listingManifestHash: Hex;
  maxOpenOrders: number;
}): Promise<{ transaction: ProviderTransaction; fresh: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const existing = await client.query<ProviderTransaction>(
      `SELECT * FROM provider_transactions
        WHERE gateway_audience=$1 AND order_id=$2 FOR UPDATE`,
      [args.gatewayAudience, args.orderId],
    );
    if (existing.rows[0]) {
      assertSameDispatch(existing.rows[0], args.dispatchHash);
      await client.query("COMMIT");
      return { transaction: existing.rows[0], fresh: false };
    }
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`provider-capacity:${args.listingManifestHash}`],
    );
    const capacity = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM provider_transactions
        WHERE listing_manifest_hash=$1 AND state='executing'`,
      [bytes(args.listingManifestHash)],
    );
    if (BigInt(capacity.rows[0]?.count ?? "0") >= BigInt(args.maxOpenOrders)) {
      throw new Error("Outcome capacity is exhausted");
    }
    const id = `task-${randomUUID()}`;
    const inserted = await client.query<ProviderTransaction>(
      `INSERT INTO provider_transactions (
         id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
         service_slug,skill_id,listing_manifest_hash,state
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'executing')
       RETURNING *`,
      [
        id, args.gatewayAudience, args.orderId, bytes(args.dispatchNonce),
        bytes(args.dispatchHash), bytes(args.requestHash), args.payer,
        args.serviceSlug, args.skillId, bytes(args.listingManifestHash),
      ],
    );
    await client.query("COMMIT");
    return { transaction: inserted.rows[0]!, fresh: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const databaseError = error as { code?: string };
    if (databaseError.code === "23505") {
      const existing = await findTransaction(args.gatewayAudience, args.orderId);
      if (existing) {
        assertSameDispatch(existing, args.dispatchHash);
        return { transaction: existing, fresh: false };
      }
      throw new Error("Dispatch nonce was already used");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function completeTransaction(
  id: string,
  result: ServiceResult,
): Promise<ProviderTransaction> {
  const state = result.status;
  const updated = await pool.query<ProviderTransaction>(
    `UPDATE provider_transactions
        SET state=$2,result=$3::jsonb,completed_at=now()
      WHERE id=$1 AND state='executing'
      RETURNING *`,
    [id, state, JSON.stringify(result)],
  );
  if (!updated.rows[0]) {
    throw new Error("Transaction completion claim was lost");
  }
  return updated.rows[0];
}

export async function getTransaction(id: string): Promise<ProviderTransaction | null> {
  const result = await pool.query<ProviderTransaction>(
    "SELECT * FROM provider_transactions WHERE id=$1",
    [id],
  );
  return result.rows[0] ?? null;
}

function assertSameDispatch(transaction: ProviderTransaction, dispatchHash: Hex): void {
  if (`0x${transaction.dispatch_hash.toString("hex")}` !== dispatchHash) {
    throw new Error("Changed dispatch replay rejected");
  }
}

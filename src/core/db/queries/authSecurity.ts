import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { pool } from "../pool.js";
import { config } from "../../config.js";
import { protectedLookupHash } from "../../chain/encryption.js";

export const MAX_ACTIVE_SIWE_NONCES = 10_000;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function protectedDigest(value: string, purpose: string): Buffer {
  const tagged = protectedLookupHash(value, purpose);
  const digest = tagged.slice(tagged.lastIndexOf(":") + 1);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("protected lookup digest is malformed");
  }
  return Buffer.from(digest, "hex");
}

export function normalizeRateLimitIdentity(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const unwrapped = trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
  return isIP(unwrapped) ? unwrapped : trimmed || "unknown";
}

export async function consumeAuthRateLimit(args: {
  scope: string;
  identity: string;
  limit: number;
  windowSeconds: number;
}): Promise<boolean> {
  if (args.limit < 1 || args.windowSeconds < 1) return false;
  const key = protectedDigest(
    `${args.scope}:${normalizeRateLimitIdentity(args.identity)}`,
    "auth-rate-limit",
  );
  const result = await pool.query(
    `INSERT INTO auth_rate_limit_buckets
       (key_hash, window_start, request_count, expires_at)
     VALUES ($1, now(), 1, now() + ($3 * interval '1 second'))
     ON CONFLICT (key_hash) DO UPDATE SET
       request_count = CASE
         WHEN auth_rate_limit_buckets.expires_at <= now() THEN 1
         ELSE auth_rate_limit_buckets.request_count + 1
       END,
       window_start = CASE
         WHEN auth_rate_limit_buckets.expires_at <= now() THEN now()
         ELSE auth_rate_limit_buckets.window_start
       END,
       expires_at = CASE
         WHEN auth_rate_limit_buckets.expires_at <= now()
           THEN now() + ($3 * interval '1 second')
         ELSE auth_rate_limit_buckets.expires_at
       END
     RETURNING request_count <= $2 AS allowed`,
    [key, args.limit, args.windowSeconds],
  );
  return (result.rows[0] as { allowed: boolean } | undefined)?.allowed === true;
}

/** Store a nonce hash in a globally bounded pool under a short DB lock. */
export async function storeSiweNonce(args: {
  nonce: string;
  requestIp: string;
  expiresAt: Date;
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('siwe_nonce_pool'))");
    await client.query(`DELETE FROM siwe_nonces WHERE expires_at <= now()`);
    const count = await client.query(
      `SELECT COUNT(*)::int AS n
         FROM siwe_nonces
        WHERE consumed_at IS NULL AND expires_at > now()`,
    );
    if ((count.rows[0] as { n: number }).n >= MAX_ACTIVE_SIWE_NONCES) {
      await client.query("ROLLBACK");
      return false;
    }
    const result = await client.query(
      `INSERT INTO siwe_nonces (nonce_hash, issued_ip_hash, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (nonce_hash) DO NOTHING
       RETURNING nonce_hash`,
      [
        sha256(args.nonce),
        protectedDigest(normalizeRateLimitIdentity(args.requestIp), "siwe-issued-ip"),
        args.expiresAt,
      ],
    );
    await client.query("COMMIT");
    return result.rowCount === 1;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Atomically burn a live nonce. Concurrent verification has one winner. */
export async function consumeSiweNonce(nonce: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE siwe_nonces
        SET consumed_at = now()
      WHERE nonce_hash = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING nonce_hash`,
    [sha256(nonce)],
  );
  return result.rowCount === 1;
}

export async function purgeExpiredAuthState(): Promise<{
  siweNonces: number;
  rateBuckets: number;
  confirmationIntents: number;
}> {
  const [nonces, buckets, intents] = await Promise.all([
    pool.query(`DELETE FROM siwe_nonces WHERE expires_at <= now()`),
    pool.query(`DELETE FROM auth_rate_limit_buckets WHERE expires_at <= now()`),
    pool.query(
      `DELETE FROM operator_confirmation_intents
        WHERE execution_status <> 'executing'
          AND (
            (consumed_at IS NULL AND expires_at <= now())
            OR (
              execution_status = 'succeeded'
              AND execution_finished_at
                <= now() - ($1 * interval '1 day')
            )
            OR (
              execution_status IN ('failed','outcome_unknown')
              AND execution_finished_at
                <= now() - ($1 * interval '1 day')
              AND NOT EXISTS (
                SELECT 1 FROM escalations e
                 WHERE e.thread_id = operator_confirmation_intents.thread_id
                   AND e.status IN (
                     'pending','in_agent_review','awaiting_human',
                     'resolution_queued','rejection_queued','resolution_executing',
                     'resolution_result_ready','resolution_attention'
                   )
              )
            )
          )`,
      [config.OPERATOR_CHAT_RETENTION_DAYS],
    ),
  ]);
  return {
    siweNonces: nonces.rowCount ?? 0,
    rateBuckets: buckets.rowCount ?? 0,
    confirmationIntents: intents.rowCount ?? 0,
  };
}

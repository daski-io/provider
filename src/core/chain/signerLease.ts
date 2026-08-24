import { pool } from "../db/pool.js";
import { withSessionAdvisoryLock } from "../db/sessionAdvisoryLock.js";
import type { ProviderWriteScope } from "../db/queries/providerChainWrites.js";

const SIGNER_LOCK_PREFIX = "daski:provider-wallet-signer:v2";
const DEFAULT_WAIT_MS = 30_000;

/**
 * Serializes provider-wallet writes across every replica. PostgreSQL releases
 * the session advisory lock automatically if a worker crashes or disconnects.
 */
export async function withProviderSignerLease<T>(
  scope: ProviderWriteScope,
  work: () => Promise<T>,
  waitMs = DEFAULT_WAIT_MS,
): Promise<T> {
  const lockName =
    `${SIGNER_LOCK_PREFIX}:${scope.chainId}:${scope.walletAddress.toLowerCase()}`;
  const result = await withSessionAdvisoryLock({
    connect: () => pool.connect(),
    async acquire(client) {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        const claim = await client.query<{ acquired: boolean }>(
          `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
          [lockName],
        );
        if (claim.rows[0]?.acquired === true) {
          return { status: "acquired" };
        }
        if (claim.rows[0]?.acquired !== false) {
          throw new Error("provider-wallet signer lease returned an invalid lock result");
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return { status: "busy", session: "clean" };
    },
    async unlock(client) {
      const unlocked = await client.query<{ unlocked: boolean }>(
        `SELECT pg_advisory_unlock(hashtext($1)) AS unlocked`,
        [lockName],
      );
      return unlocked.rows[0]?.unlocked === true;
    },
    work: () => work(),
  });
  if (result.status === "busy") {
    throw new Error("Timed out waiting for the distributed provider-wallet signer lease");
  }
  return result.value;
}

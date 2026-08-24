import { pool } from "../db/pool.js";
import type { Queryable } from "../db/queryable.js";
import { withSessionAdvisoryLock } from "../db/sessionAdvisoryLock.js";

const REFUND_COMPLIANCE_LOCK = "daski:compliance-refunds:v1";

/** Holds the shared compliance/refund exclusion lock across provider writes. */
export async function withComplianceRefundLease<T>(
  work: () => Promise<T>,
): Promise<T> {
  const result = await withSessionAdvisoryLock({
    connect: () => pool.connect(),
    async acquire(client) {
      await client.query(
        `SELECT pg_advisory_lock(hashtext($1))`,
        [REFUND_COMPLIANCE_LOCK],
      );
      return { status: "acquired" };
    },
    async unlock(client) {
      const unlocked = await client.query<{ unlocked: boolean }>(
        `SELECT pg_advisory_unlock(hashtext($1)) AS unlocked`,
        [REFUND_COMPLIANCE_LOCK],
      );
      return unlocked.rows[0]?.unlocked === true;
    },
    work: () => work(),
  });
  if (result.status === "busy") {
    throw new Error("compliance/refund lease unexpectedly reported busy");
  }
  return result.value;
}

/** Compliance mutations take the same lock until their database commit. */
export async function lockComplianceRefundMutations(db: Queryable): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [REFUND_COMPLIANCE_LOCK]);
}

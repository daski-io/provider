import { pool } from "../db/pool.js";
import { withSessionAdvisoryLock } from "../db/sessionAdvisoryLock.js";
import { SupplierOutcomeAmbiguousError } from "./errorClassifier.js";

/**
 * Serialize supplier work for one external resource across every provider
 * replica. The callback may perform network and database I/O, so this uses a
 * dedicated session-level advisory lock instead of holding a transaction open.
 */
export async function withSupplierResourceLock<T>(
  namespace: string,
  resourceKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const result = await withSessionAdvisoryLock({
    connect: async () => {
      try {
        return await pool.connect();
      } catch (error) {
        throw new SupplierOutcomeAmbiguousError(
          `supplier resource '${namespace}:${resourceKey}' could not acquire a database session: ${(error as Error).message}`,
        );
      }
    },
    async acquire(client) {
      try {
        await client.query(
          "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
          [namespace, resourceKey],
        );
        return { status: "acquired" };
      } catch (error) {
        throw new SupplierOutcomeAmbiguousError(
          `supplier resource '${namespace}:${resourceKey}' could not acquire its lock: ${(error as Error).message}`,
        );
      }
    },
    async unlock(client) {
      const unlocked = await client.query<{ unlocked: boolean }>(
        "SELECT pg_advisory_unlock(hashtext($1), hashtext($2)) AS unlocked",
        [namespace, resourceKey],
      );
      return unlocked.rows[0]?.unlocked === true;
    },
    work: () => operation(),
  });
  if (result.status === "busy") {
    throw new SupplierOutcomeAmbiguousError(
      `supplier resource '${namespace}:${resourceKey}' unexpectedly reported busy`,
    );
  }
  return result.value;
}

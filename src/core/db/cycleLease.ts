import { pool } from "./pool.js";
import { withSessionAdvisoryLock } from "./sessionAdvisoryLock.js";

// Cross-replica cycle lease for interval workers that poll suppliers or the
// chain. A PostgreSQL session advisory lock ensures one replica performs a
// cycle; per-item conditional writes remain the correctness boundary.
export async function withCycleLease<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const result = await withSessionAdvisoryLock({
    connect: () => pool.connect(),
    async acquire(client) {
      const claim = await client.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`,
        [name],
      );
      if (claim.rows[0]?.ok === true) return { status: "acquired" };
      if (claim.rows[0]?.ok === false) {
        return { status: "busy", session: "clean" };
      }
      throw new Error("cycle lease returned an invalid lock result");
    },
    async unlock(client) {
      const unlocked = await client.query<{ unlocked: boolean }>(
        `SELECT pg_advisory_unlock(hashtext($1)) AS unlocked`,
        [name],
      );
      return unlocked.rows[0]?.unlocked === true;
    },
    work: () => fn(),
  });
  return result.status === "busy" ? null : result.value;
}

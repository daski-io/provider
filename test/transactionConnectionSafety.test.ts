import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { inTransaction } from "../src/core/db/queryable.js";

function mockedPool(query: (sql: string) => Promise<unknown>) {
  const release = vi.fn();
  const client = { query: vi.fn(query), release } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { pool, release };
}

describe("transaction connection safety", () => {
  it("returns a successfully rolled-back connection to the pool", async () => {
    const { pool, release } = mockedPool(async () => ({ rows: [] }));

    await expect(
      inTransaction(pool, async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");

    expect(release).toHaveBeenCalledWith(false);
  });

  it("destroys a connection when rollback cannot establish a clean session", async () => {
    const { pool, release } = mockedPool(async (sql) => {
      if (sql === "ROLLBACK") throw new Error("connection lost");
      return { rows: [] };
    });

    await expect(
      inTransaction(pool, async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");

    expect(release).toHaveBeenCalledWith(true);
  });
});

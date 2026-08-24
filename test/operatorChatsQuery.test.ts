import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/core/db/pool.js", () => ({
  pool: { query },
}));
vi.mock("../src/core/chain/encryption.js", () => ({
  decryptString: (value: string) => value,
  encryptString: (value: string) => value,
}));

import { listMessagesForThreads } from "../src/core/db/queries/operatorChats.js";

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [] });
});

describe("batched operator chat history", () => {
  it("limits each thread in SQL with deterministic ordering", async () => {
    await listMessagesForThreads(["thread-1", "thread-2"], 25);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ROW_NUMBER() OVER");
    expect(sql).toContain("PARTITION BY thread_id");
    expect(sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(sql).toContain("WHERE thread_rank <= $2");
    expect(sql).toContain("ORDER BY thread_id, created_at ASC, id ASC");
    expect(params).toEqual([["thread-1", "thread-2"], 25]);
  });
});

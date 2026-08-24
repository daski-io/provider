import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("../src/core/db/pool.js", () => ({
  pool: { connect: mocks.connect },
}));

import { withSupplierResourceLock } from "../src/core/suppliers/resourceLock.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({
    query: mocks.query,
    release: mocks.release,
    on: vi.fn(),
    removeListener: vi.fn(),
  });
  mocks.query.mockImplementation(async (sql: string) =>
    sql.includes("pg_advisory_unlock")
      ? { rows: [{ unlocked: true }] }
      : { rows: [{}] },
  );
});

describe("withSupplierResourceLock", () => {
  it("holds one session-level lock around the operation", async () => {
    const operation = vi.fn(async () => "done");

    await expect(
      withSupplierResourceLock("sample-asset", "asset-1", operation),
    ).resolves.toBe("done");

    expect(mocks.query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
      ["sample-asset", "asset-1"],
    );
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      "SELECT pg_advisory_unlock(hashtext($1), hashtext($2)) AS unlocked",
      ["sample-asset", "asset-1"],
    );
    expect(mocks.release).toHaveBeenCalledWith(false);
  });

  it("unlocks and rethrows when the protected operation fails", async () => {
    const failure = new Error("supplier failed");

    await expect(
      withSupplierResourceLock(
        "sample-supplier-item",
        "example.com",
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.release).toHaveBeenCalledWith(false);
  });
});

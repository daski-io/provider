import type { Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  release: vi.fn(),
  poolQuery: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: mocks.poolQuery,
    connect: mocks.connect,
  },
}));

import {
  claimTransaction,
  completeTransaction,
} from "../src/core/standardRail/transactionStore.js";

const hash = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const payer = `0x${"11".repeat(20)}` as Hex;

function transaction(dispatchHash = hash("2")) {
  return {
    id: "task-1",
    gateway_audience: "https://gateway.example",
    order_id: "order-1",
    dispatch_hash: Buffer.from(dispatchHash.slice(2), "hex"),
    payer,
    service_slug: "dummy",
    skill_id: "echo",
    state: "executing" as const,
    result: null,
    created_at: new Date(),
    completed_at: null,
  };
}

const claim = () => claimTransaction({
  gatewayAudience: "https://gateway.example",
  orderId: "order-1",
  dispatchNonce: hash("1"),
  dispatchHash: hash("2"),
  requestHash: hash("3"),
  payer,
  serviceSlug: "dummy",
  skillId: "echo",
  listingManifestHash: hash("4"),
  maxOpenOrders: 1,
});

describe("minimal transaction store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({
      query: mocks.clientQuery,
      release: mocks.release,
    });
  });

  it("claims a fresh dispatch in one serializable transaction", async () => {
    const row = transaction();
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(claim()).resolves.toEqual({ transaction: row, fresh: true });
    expect(mocks.clientQuery.mock.calls[0]?.[0]).toContain("SERIALIZABLE");
    expect(mocks.clientQuery.mock.calls[4]?.[0]).toContain("INSERT INTO provider_transactions");
    expect(mocks.clientQuery.mock.calls[5]?.[0]).toBe("COMMIT");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("returns an exact same replay without executing a second claim", async () => {
    const row = transaction();
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(claim()).resolves.toEqual({ transaction: row, fresh: false });
    expect(mocks.clientQuery).toHaveBeenCalledTimes(3);
    expect(mocks.clientQuery.mock.calls[2]?.[0]).toBe("COMMIT");
  });

  it("rejects a changed dispatch replay and rolls back", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [transaction(hash("9"))] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(claim()).rejects.toThrow("Changed dispatch replay rejected");
    expect(mocks.clientQuery.mock.calls[2]?.[0]).toBe("ROLLBACK");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("persists a terminal result only from executing state", async () => {
    const completed = {
      ...transaction(),
      state: "completed" as const,
      result: { status: "completed" as const, message: "done" },
      completed_at: new Date(),
    };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [completed] });
    await expect(completeTransaction("task-1", completed.result)).resolves.toBe(completed);
    expect(mocks.poolQuery.mock.calls[0]?.[0]).toContain("state='executing'");

    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(completeTransaction("task-1", completed.result))
      .rejects.toThrow("Transaction completion claim was lost");
  });
});

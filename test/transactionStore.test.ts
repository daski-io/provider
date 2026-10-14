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
  AdmissionExpiredError,
  AdmissionUncertainError,
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
    operations_revision: 0,
    operations_projection: { fulfillment: null, support: null, recovery: null },
    observed_at: "1900000000",
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
  dispatchValidBefore: 1_900_000_300,
});

describe("minimal transaction store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({
      query: mocks.clientQuery,
      release: mocks.release,
    });
  });

  it("claims a funded dispatch without consulting capacity and records its deadline", async () => {
    const row = transaction();
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(claim()).resolves.toEqual({ transaction: row, fresh: true });
    const statements = mocks.clientQuery.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("FOR UPDATE");
    expect(statements[2]).toContain("INSERT INTO provider_transactions");
    expect(statements[2]).toContain("to_timestamp($11)");
    expect(mocks.clientQuery.mock.calls[2]?.[1]?.[10]).toBe(1_900_000_300);
    expect(statements[3]).toBe("COMMIT");
    expect(statements.join("\n")).not.toMatch(/count\(|advisory/);
    expect(mocks.release).toHaveBeenCalledWith(false);
  });

  it("returns an existing claim unchanged for the caller to compare", async () => {
    const row = transaction(hash("9"));
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(claim()).resolves.toEqual({ transaction: row, fresh: false });
    expect(mocks.clientQuery).toHaveBeenCalledTimes(3);
    expect(mocks.clientQuery.mock.calls[2]?.[0]).toBe("COMMIT");
  });

  it("reports the commit-time admission deadline as a definite non-admission", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [transaction()] })
      .mockRejectedValueOnce(Object.assign(new Error("deadline"), {
        code: "23514",
        constraint: "provider_transactions_admission_deadline",
      }));

    await expect(claim()).rejects.toBeInstanceOf(AdmissionExpiredError);
    expect(mocks.release).toHaveBeenCalledWith(false);
  });

  it("treats a lost COMMIT acknowledgement as uncertain and discards the session", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [transaction()] })
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));

    const error = await claim().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdmissionUncertainError);
    expect((error as AdmissionUncertainError).taskId).toMatch(/^task-/);
    expect(mocks.release).toHaveBeenCalledWith(true);
  });

  it("resolves a unique race to the winning claim and rethrows other pre-commit failures", async () => {
    const winner = transaction();
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "23505" }))
      .mockResolvedValueOnce({ rows: [] });
    mocks.poolQuery.mockResolvedValueOnce({ rows: [winner] });
    await expect(claim()).resolves.toEqual({ transaction: winner, fresh: false });

    mocks.clientQuery.mockReset()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("statement timeout"))
      .mockResolvedValueOnce({ rows: [] });
    await expect(claim()).rejects.toThrow("statement timeout");
    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("persists a terminal result only from executing state and serves a finalized row", async () => {
    const completed = {
      ...transaction(),
      state: "completed" as const,
      result: { status: "completed" as const, message: "done" },
      completed_at: new Date(),
    };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [completed] });
    await expect(completeTransaction("task-1", completed.result)).resolves.toBe(completed);
    expect(mocks.poolQuery.mock.calls[0]?.[0]).toContain("state='executing'");

    mocks.poolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [completed] });
    await expect(completeTransaction("task-1", completed.result)).resolves.toBe(completed);

    mocks.poolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(completeTransaction("task-1", completed.result))
      .rejects.toThrow("Transaction completion claim was lost");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "../src/core/db/queryable.js";

const state = vi.hoisted(() => ({
  acquireResult: true as boolean | undefined,
  unlockResult: true as boolean | undefined,
  queries: [] as Array<{ sql: string; values?: unknown[] }>,
  release: vi.fn(),
}));

vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    connect: vi.fn(async () => ({
      async query(sql: string, values?: unknown[]) {
        state.queries.push({ sql, values });
        if (sql.includes("pg_try_advisory_lock")) {
          return { rows: [{ acquired: state.acquireResult }] };
        }
        if (sql.includes("pg_advisory_unlock")) {
          return { rows: [{ unlocked: state.unlockResult }] };
        }
        return { rows: [] };
      },
      release: state.release,
      on: vi.fn(),
      removeListener: vi.fn(),
    })),
  },
}));

import {
  withComplianceRefundLease,
  lockComplianceRefundMutations,
} from "../src/core/compliance/lease.js";
import { withProviderSignerLease } from "../src/core/chain/signerLease.js";

const signerScope = {
  chainId: 8453,
  walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
};

beforeEach(() => {
  vi.clearAllMocks();
  state.queries = [];
  state.acquireResult = true;
  state.unlockResult = true;
});
describe("critical distributed lease wrappers", () => {
  it("binds signer acquisition and unlock to the exact normalized identity", async () => {
    await expect(
      withProviderSignerLease(signerScope, async () => "signed"),
    ).resolves.toBe("signed");

    expect(state.queries).toHaveLength(2);
    expect(state.queries[0]!.values).toEqual([
      "daski:provider-wallet-signer:v2:8453:0x1234567890abcdef1234567890abcdef12345678",
    ]);
    expect(state.queries[1]!.values).toEqual(state.queries[0]!.values);
    expect(state.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("returns a signer timeout from a definitively clean session", async () => {
    await expect(
      withProviderSignerLease(signerScope, async () => "unreachable", 0),
    ).rejects.toThrow(/timed out/i);

    expect(state.queries).toHaveLength(0);
    expect(state.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("destroys a signer session after an invalid acquire result", async () => {
    state.acquireResult = undefined;

    await expect(
      withProviderSignerLease(signerScope, async () => "unreachable", 1_000),
    ).rejects.toThrow(/invalid lock result/i);

    expect(state.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("waits for a contended signer lease and then acquires it", async () => {
    vi.useFakeTimers();
    state.acquireResult = false;
    const lease = withProviderSignerLease(
      signerScope,
      async () => "signed-after-wait",
      1_000,
    );
    await vi.waitFor(() => {
      expect(state.queries).toHaveLength(1);
    });
    state.acquireResult = true;
    await vi.advanceTimersByTimeAsync(250);

    await expect(lease).resolves.toBe("signed-after-wait");
    vi.useRealTimers();
  });

  it("destroys a signer session when exact unlock is not confirmed", async () => {
    state.unlockResult = false;

    await expect(
      withProviderSignerLease(signerScope, async () => "signed"),
    ).resolves.toBe("signed");
    expect(state.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("uses the same compliance identity for session and transaction locks", async () => {
    await expect(
      withComplianceRefundLease(async () => "complete"),
    ).resolves.toBe("complete");

    const transactionQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const db = { query: transactionQuery } as unknown as Queryable;
    await lockComplianceRefundMutations(db);

    const leaseValues = state.queries.map(({ values }) => values);
    expect(leaseValues).toEqual([
      ["daski:compliance-refunds:v1"],
      ["daski:compliance-refunds:v1"],
    ]);
    expect(transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_xact_lock"),
      ["daski:compliance-refunds:v1"],
    );
  });

  it("destroys a compliance session when unlock is not confirmed", async () => {
    state.unlockResult = undefined;

    await expect(
      withComplianceRefundLease(async () => "complete"),
    ).resolves.toBe("complete");
    expect(state.release).toHaveBeenCalledExactlyOnceWith(true);
  });
});

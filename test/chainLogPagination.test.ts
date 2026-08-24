import { describe, expect, it } from "vitest";
import { loadLogsPaged } from "../src/core/standardRail/chainLogPagination.js";

describe("loadLogsPaged", () => {
  it("does not reject more than 10,000 cumulative events", async () => {
    const logs = await loadLogsPaged({
      fromBlock: 1n,
      toBlock: 20_001n,
      maximumPageEvents: 10_000,
      load: async () => Array.from({ length: 5_001 }, (_, index) => index),
    });

    expect(logs).toHaveLength(15_003);
  });

  it("subdivides dense ranges and accepts a dense single block", async () => {
    const ranges: Array<[bigint, bigint]> = [];
    const logs = await loadLogsPaged({
      fromBlock: 7n,
      toBlock: 8n,
      maximumPageEvents: 1,
      load: async (fromBlock, toBlock) => {
        ranges.push([fromBlock, toBlock]);
        return fromBlock === toBlock ? [fromBlock, fromBlock] : [fromBlock, toBlock];
      },
    });

    expect(ranges).toContainEqual([7n, 7n]);
    expect(ranges).toContainEqual([8n, 8n]);
    expect(logs).toEqual([7n, 7n, 8n, 8n]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid maximum page event count %s",
    async (maximumPageEvents) => {
      await expect(loadLogsPaged({
        fromBlock: 1n,
        toBlock: 1n,
        maximumPageEvents,
        load: async () => [],
      })).rejects.toThrow("maximumPageEvents must be a positive safe integer");
    },
  );

  it("does not query an inverted range", async () => {
    let loads = 0;
    const logs = await loadLogsPaged({
      fromBlock: 2n,
      toBlock: 1n,
      maximumPageEvents: 1,
      load: async () => {
        loads += 1;
        return [];
      },
    });

    expect(logs).toEqual([]);
    expect(loads).toBe(0);
  });

  it("uses inclusive, non-overlapping 10,000-block windows", async () => {
    const ranges: Array<[bigint, bigint]> = [];
    await loadLogsPaged({
      fromBlock: 1n,
      toBlock: 20_001n,
      maximumPageEvents: 100,
      load: async (fromBlock, toBlock) => {
        ranges.push([fromBlock, toBlock]);
        return [];
      },
    });

    expect(ranges).toEqual([
      [1n, 10_000n],
      [10_001n, 20_000n],
      [20_001n, 20_001n],
    ]);
  });

  it("subdivides a multi-block page at the exact threshold", async () => {
    const ranges: Array<[bigint, bigint]> = [];
    const logs = await loadLogsPaged({
      fromBlock: 7n,
      toBlock: 8n,
      maximumPageEvents: 2,
      load: async (fromBlock, toBlock) => {
        ranges.push([fromBlock, toBlock]);
        return fromBlock === toBlock ? [fromBlock] : [fromBlock, toBlock];
      },
    });

    expect(ranges).toEqual([[7n, 8n], [7n, 7n], [8n, 8n]]);
    expect(logs).toEqual([7n, 8n]);
  });

  it("recovers from multi-block RPC range failures by subdividing", async () => {
    const logs = await loadLogsPaged({
      fromBlock: 7n,
      toBlock: 10n,
      maximumPageEvents: 10,
      load: async (fromBlock, toBlock) => {
        if (fromBlock !== toBlock) throw new Error("query range too dense");
        return [fromBlock];
      },
    });

    expect(logs).toEqual([7n, 8n, 9n, 10n]);
  });

  it("rethrows an indivisible single-block RPC failure", async () => {
    const failure = new Error("single block unavailable");
    await expect(loadLogsPaged({
      fromBlock: 7n,
      toBlock: 7n,
      maximumPageEvents: 10,
      load: async () => { throw failure; },
    })).rejects.toBe(failure);
  });
});

import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  logsStrictlyBetween,
  selectPreviousRelease,
  selectReleaseAtPosition,
  type ReleasedLog,
} from "../src/core/standardRail/evidencePosition.js";

const splitter = "0x1111111111111111111111111111111111111111" as Address;
const other = "0x2222222222222222222222222222222222222222" as Address;

function released(
  logIndex: number,
  releaseSequence: bigint,
  address: Address = splitter,
  transactionIndex = 0,
): ReleasedLog {
  return { blockNumber: 100n, transactionIndex, logIndex, address, args: { releaseSequence } };
}

describe("release evidence positions", () => {
  it("selects one exact splitter log from a receipt containing multiple releases", () => {
    const logs = [released(4, 8n), released(9, 9n), released(12, 10n), released(9, 9n, other)];

    expect(selectReleaseAtPosition(logs, splitter, {
      blockNumber: 100n, transactionIndex: 0, logIndex: 9, releaseSequence: 9n,
    })).toBe(logs[1]);
  });

  it("binds release sequence as well as log index", () => {
    expect(() => selectReleaseAtPosition([released(9, 8n)], splitter, {
      blockNumber: 100n, transactionIndex: 0, logIndex: 9, releaseSequence: 9n,
    }))
      .toThrow("Release event is missing or ambiguous");
  });

  it("binds the block and transaction index, not only the log index", () => {
    expect(() => selectReleaseAtPosition([released(9, 9n, splitter, 1)], splitter, {
      blockNumber: 100n, transactionIndex: 0, logIndex: 9, releaseSequence: 9n,
    }))
      .toThrow("Release event is missing or ambiguous");
  });

  it("selects only the exact N-1 release before the chosen event", () => {
    const current = released(12, 10n);
    const expected = released(9, 9n);
    const candidates = [released(4, 8n), expected, released(14, 9n)];

    expect(selectPreviousRelease(candidates, current, 9n)).toBe(expected);
  });

  it("bounds payout and credit logs between the prior and selected releases", () => {
    const previous = released(5, 8n);
    const current = released(8, 9n);
    const transfers = [
      { blockNumber: 100n, transactionIndex: 0, logIndex: 4, label: "before" },
      { blockNumber: 100n, transactionIndex: 0, logIndex: 6, label: "provider" },
      { blockNumber: 100n, transactionIndex: 0, logIndex: 7, label: "commission" },
      { blockNumber: 100n, transactionIndex: 0, logIndex: 9, label: "after" },
    ];

    expect(logsStrictlyBetween(transfers, previous, current).map(({ label }) => label))
      .toEqual(["provider", "commission"]);
  });

  it("uses activation end-of-block as the first interval boundary", () => {
    const current = { blockNumber: 102n, transactionIndex: 0, logIndex: 8 };
    const transfers = [
      { blockNumber: 101n, transactionIndex: 4, logIndex: 9, amount: 10n },
      { blockNumber: 102n, transactionIndex: 0, logIndex: 4, amount: 20n },
      { blockNumber: 102n, transactionIndex: 0, logIndex: 9, amount: 30n },
    ];

    expect(logsStrictlyBetween(transfers, null, current).map(({ amount }) => amount))
      .toEqual([10n, 20n]);
  });
});

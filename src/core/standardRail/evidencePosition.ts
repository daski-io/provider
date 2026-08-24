import type { Address } from "viem";

export interface PositionedLog {
  blockNumber: bigint | null;
  transactionIndex: number | null;
  logIndex: number | null;
}

type CompletePosition = readonly [bigint, bigint, bigint];

export function position(value: PositionedLog): CompletePosition {
  if (value.blockNumber === null || value.transactionIndex === null || value.logIndex === null) {
    throw new Error("Chain log position is incomplete");
  }
  return [value.blockNumber, BigInt(value.transactionIndex), BigInt(value.logIndex)];
}

export function comparePosition(left: CompletePosition, right: CompletePosition): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}

export function logsStrictlyBetween<T extends PositionedLog>(
  logs: readonly T[],
  start: PositionedLog | null,
  end: PositionedLog,
): T[] {
  const startPosition = start ? position(start) : null;
  const endPosition = position(end);
  return logs.filter((log) =>
    (!startPosition || comparePosition(position(log), startPosition) > 0) &&
    comparePosition(position(log), endPosition) < 0,
  ).sort((left, right) => comparePosition(position(left), position(right)));
}

export interface ReleasedLog extends PositionedLog {
  address: Address;
  args: { releaseSequence?: bigint };
}

export function selectReleaseAtPosition<T extends ReleasedLog>(
  releases: readonly T[],
  splitter: Address,
  expected: {
    blockNumber: bigint;
    transactionIndex: number;
    logIndex: number;
    releaseSequence: bigint;
  },
): T {
  const selected = releases.filter((event) =>
    event.address.toLowerCase() === splitter.toLowerCase() &&
    event.blockNumber === expected.blockNumber &&
    event.transactionIndex === expected.transactionIndex &&
    event.logIndex === expected.logIndex &&
    event.args.releaseSequence === expected.releaseSequence,
  );
  if (selected.length !== 1) throw new Error("Release event is missing or ambiguous");
  return selected[0]!;
}

export function selectPreviousRelease<C extends ReleasedLog, R extends ReleasedLog>(
  candidates: readonly C[],
  release: R,
  expectedSequence: bigint,
): C {
  const previous = candidates.filter((event) =>
    event.address.toLowerCase() === release.address.toLowerCase() &&
    event.args.releaseSequence === expectedSequence &&
    comparePosition(position(event), position(release)) < 0,
  );
  if (previous.length !== 1) throw new Error("Previous release event is missing or ambiguous");
  return previous[0]!;
}

import { getAddress, type Address, type Hex } from "viem";
import {
  logsStrictlyBetween,
  type PositionedLog,
} from "./evidencePosition.js";

export interface TokenTransferLog extends PositionedLog {
  readonly address: Address;
  readonly transactionHash: Hex | null;
  readonly args: {
    readonly from?: Address;
    readonly to?: Address;
    readonly value?: bigint;
  };
}

export interface CoveredReleaseLog extends PositionedLog {
  readonly transactionHash: Hex | null;
  readonly args: {
    readonly outcomeIdHash: Hex;
    readonly listingEpoch: bigint;
    readonly releaseSequence: bigint;
    readonly policyVersionHash: Hex;
    readonly listingCommitmentHash: Hex;
    readonly grossAmount: bigint;
    readonly providerNetAmount: bigint;
    readonly daskiCommissionAmount: bigint;
  };
}

interface ReleaseCoverageInput<T extends TokenTransferLog, R extends CoveredReleaseLog> {
  token: Address;
  splitter: Address;
  providerPayee: Address;
  daskiCommissionReceiver: Address;
  commissionBps: number;
  outcomeIdHash: Hex;
  listingEpoch: bigint;
  policyVersionHash: Hex;
  listingCommitmentHash: Hex;
  initialBalance: bigint;
  previousRelease: PositionedLog | null;
  release: R;
  credits: readonly T[];
  receiptTransfers: readonly T[];
  deposit: {
    transactionHash: Hex;
    blockNumber: bigint;
    transactionIndex: number;
    logIndex: number;
    payer: Address;
    grossAmount: bigint;
  };
  expectedProviderNetAmount: bigint;
  expectedDaskiCommissionAmount: bigint;
}

export interface ReleaseCoverage<T extends TokenTransferLog> {
  interval: T[];
  intervalGross: bigint;
  orderProviderNetAmount: bigint;
  orderDaskiCommissionAmount: bigint;
}

function sameAddress(left: Address | undefined, right: Address): boolean {
  return left !== undefined && getAddress(left) === getAddress(right);
}

function valueOf(log: TokenTransferLog): bigint {
  if (log.args.value === undefined) throw new Error("Token transfer amount is unavailable");
  return log.args.value;
}

export function verifyReleaseCoverage<T extends TokenTransferLog, R extends CoveredReleaseLog>(
  args: ReleaseCoverageInput<T, R>,
): ReleaseCoverage<T> {
  if (
    !Number.isSafeInteger(args.commissionBps) ||
    args.commissionBps <= 0 ||
    args.commissionBps >= 10_000 ||
    args.initialBalance < 0n
  ) throw new Error("Release accounting policy is invalid");

  const interval = logsStrictlyBetween(args.credits, args.previousRelease, args.release);
  for (const credit of interval) {
    if (
      getAddress(credit.address) !== getAddress(args.token) ||
      !sameAddress(credit.args.to, args.splitter)
    ) throw new Error("Release interval contains an invalid credit");
  }
  const target = interval.filter((credit) =>
    credit.transactionHash?.toLowerCase() === args.deposit.transactionHash.toLowerCase() &&
    credit.blockNumber === args.deposit.blockNumber &&
    credit.transactionIndex === args.deposit.transactionIndex &&
    credit.logIndex === args.deposit.logIndex &&
    sameAddress(credit.args.from, args.deposit.payer) &&
    valueOf(credit) === args.deposit.grossAmount
  );
  if (target.length !== 1) {
    throw new Error("Release interval does not contain the exact dispatched deposit");
  }
  const targetIndex = interval.indexOf(target[0]!);
  const intervalGross = interval.reduce(
    (total, credit) => total + valueOf(credit),
    args.initialBalance,
  );
  const cumulativeBefore = interval.slice(0, targetIndex).reduce(
    (total, credit) => total + valueOf(credit),
    args.initialBalance,
  );
  const cumulativeAfter = cumulativeBefore + args.deposit.grossAmount;
  const commissionBefore = cumulativeBefore * BigInt(args.commissionBps) / 10_000n;
  const commissionAfter = cumulativeAfter * BigInt(args.commissionBps) / 10_000n;
  const orderDaskiCommissionAmount = commissionAfter - commissionBefore;
  const orderProviderNetAmount = args.deposit.grossAmount - orderDaskiCommissionAmount;
  const totalCommission = intervalGross * BigInt(args.commissionBps) / 10_000n;
  const totalProviderNet = intervalGross - totalCommission;

  const payouts = logsStrictlyBetween(
    args.receiptTransfers,
    args.previousRelease,
    args.release,
  ).filter((event) =>
    getAddress(event.address) === getAddress(args.token) &&
    sameAddress(event.args.from, args.splitter)
  );
  if (
    payouts.length !== 2 ||
    payouts.some((event) =>
      event.transactionHash?.toLowerCase() !== args.release.transactionHash?.toLowerCase()
    ) ||
    !sameAddress(payouts[0]!.args.to, args.providerPayee) ||
    valueOf(payouts[0]!) !== totalProviderNet ||
    !sameAddress(payouts[1]!.args.to, args.daskiCommissionReceiver) ||
    valueOf(payouts[1]!) !== totalCommission
  ) throw new Error("Release payouts are missing, reordered, or ambiguous");

  const released = args.release.args;
  if (
    released.outcomeIdHash.toLowerCase() !== args.outcomeIdHash.toLowerCase() ||
    released.listingEpoch !== args.listingEpoch ||
    released.policyVersionHash.toLowerCase() !== args.policyVersionHash.toLowerCase() ||
    released.listingCommitmentHash.toLowerCase() !== args.listingCommitmentHash.toLowerCase() ||
    released.grossAmount !== intervalGross ||
    released.providerNetAmount !== totalProviderNet ||
    released.daskiCommissionAmount !== totalCommission ||
    orderProviderNetAmount !== args.expectedProviderNetAmount ||
    orderDaskiCommissionAmount !== args.expectedDaskiCommissionAmount
  ) throw new Error("Release event does not cover the order");

  return {
    interval,
    intervalGross,
    orderProviderNetAmount,
    orderDaskiCommissionAmount,
  };
}

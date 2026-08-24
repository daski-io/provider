import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  verifyReleaseCoverage,
  type CoveredReleaseLog,
  type TokenTransferLog,
} from "../src/core/standardRail/releaseCoverage.js";

const token = "0x1111111111111111111111111111111111111111" as Address;
const splitter = "0x2222222222222222222222222222222222222222" as Address;
const payer = "0x3333333333333333333333333333333333333333" as Address;
const payee = "0x4444444444444444444444444444444444444444" as Address;
const receiver = "0x5555555555555555555555555555555555555555" as Address;
const tx = `0x${"66".repeat(32)}` as Hex;
const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;

function transfer(
  blockNumber: bigint,
  transactionIndex: number,
  logIndex: number,
  from: Address,
  to: Address,
  value: bigint,
): TokenTransferLog {
  return {
    address: token,
    blockNumber,
    transactionIndex,
    logIndex,
    transactionHash: tx,
    args: { from, to, value },
  };
}

function release(
  blockNumber: bigint,
  transactionIndex: number,
  logIndex: number,
  sequence: bigint,
  gross: bigint,
): CoveredReleaseLog {
  const commission = gross * 500n / 10_000n;
  return {
    blockNumber,
    transactionIndex,
    logIndex,
    transactionHash: tx,
    args: {
      outcomeIdHash: hash("1"),
      listingEpoch: 7n,
      releaseSequence: sequence,
      policyVersionHash: hash("2"),
      listingCommitmentHash: hash("3"),
      grossAmount: gross,
      providerNetAmount: gross - commission,
      daskiCommissionAmount: commission,
    },
  };
}

function common() {
  return {
    token,
    splitter,
    providerPayee: payee,
    daskiCommissionReceiver: receiver,
    commissionBps: 500,
    outcomeIdHash: hash("1"),
    listingEpoch: 7n,
    policyVersionHash: hash("2"),
    listingCommitmentHash: hash("3"),
  };
}

describe("release coverage", () => {
  it("uses the signed activation balance for the first post-checkpoint interval", () => {
    const selected = release(102n, 4, 8, 6n, 100n);
    const deposit = transfer(101n, 2, 3, payer, splitter, 50n);
    const provider = transfer(102n, 4, 6, splitter, payee, 95n);
    const commission = transfer(102n, 4, 7, splitter, receiver, 5n);
    const laterDeposit = transfer(102n, 4, 9, payer, splitter, 25n);

    const covered = verifyReleaseCoverage({
      ...common(),
      initialBalance: 50n,
      previousRelease: null,
      release: selected,
      credits: [deposit, laterDeposit],
      receiptTransfers: [provider, commission, laterDeposit],
      deposit: {
        transactionHash: tx,
        blockNumber: 101n,
        transactionIndex: 2,
        logIndex: 3,
        payer,
        grossAmount: 50n,
      },
      expectedProviderNetAmount: 47n,
      expectedDaskiCommissionAmount: 3n,
    });

    expect(covered.intervalGross).toBe(100n);
    expect(covered.interval).toEqual([deposit]);
  });

  it("selects payouts between exact N-1 and N releases in one wrapper transaction", () => {
    const previous = release(102n, 4, 3, 8n, 100n);
    const selected = release(102n, 4, 10, 9n, 200n);
    const deposit = transfer(102n, 4, 4, payer, splitter, 100n);
    const otherCredit = transfer(102n, 4, 5, payer, splitter, 100n);
    const oldPayout = transfer(102n, 4, 2, splitter, payee, 95n);
    const provider = transfer(102n, 4, 8, splitter, payee, 190n);
    const commission = transfer(102n, 4, 9, splitter, receiver, 10n);

    const covered = verifyReleaseCoverage({
      ...common(),
      initialBalance: 0n,
      previousRelease: previous,
      release: selected,
      credits: [deposit, otherCredit],
      receiptTransfers: [oldPayout, provider, commission],
      deposit: {
        transactionHash: tx,
        blockNumber: 102n,
        transactionIndex: 4,
        logIndex: 4,
        payer,
        grossAmount: 100n,
      },
      expectedProviderNetAmount: 95n,
      expectedDaskiCommissionAmount: 5n,
    });

    expect(covered.intervalGross).toBe(200n);
    expect(covered.interval).toEqual([deposit, otherCredit]);
  });

  it("rejects a third splitter-origin payout before the selected release", () => {
    const selected = release(102n, 4, 8, 1n, 100n);
    const deposit = transfer(101n, 2, 3, payer, splitter, 100n);
    const provider = transfer(102n, 4, 5, splitter, payee, 95n);
    const extra = transfer(102n, 4, 6, splitter, payee, 1n);
    const commission = transfer(102n, 4, 7, splitter, receiver, 5n);

    expect(() => verifyReleaseCoverage({
      ...common(),
      initialBalance: 0n,
      previousRelease: null,
      release: selected,
      credits: [deposit],
      receiptTransfers: [provider, extra, commission],
      deposit: {
        transactionHash: tx,
        blockNumber: 101n,
        transactionIndex: 2,
        logIndex: 3,
        payer,
        grossAmount: 100n,
      },
      expectedProviderNetAmount: 95n,
      expectedDaskiCommissionAmount: 5n,
    })).toThrow("Release payouts are missing, reordered, or ambiguous");
  });
});

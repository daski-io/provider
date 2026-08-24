import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbiParameters,
  parseTransaction,
  type Hex,
} from "viem";
import { walletClient } from "./client.js";

// Prepare-and-sign WITHOUT broadcasting. Callers persist the returned
// hash/nonce/serialized transaction durably and only then broadcast, so a
// crash on either side of the send can be reconciled from the exact bytes
// (rebroadcast) or from the finalized account nonce (replacement) instead
// of blindly re-signing — the pattern behind refunds and reputation
// attestations. Always call under withProviderSignerLease: the nonce is
// captured here.
export async function prepareSignedContractWrite(args: {
  address: Hex;
  abi: readonly unknown[];
  functionName: string;
  callArgs: readonly unknown[];
  /** Optional explicit gas limit (skips estimation quirks on some RPCs). */
  gas?: bigint;
  nonce: bigint;
  value?: bigint;
}): Promise<{ hash: Hex; intentHash: Hex; serialized: Hex; nonce: bigint }> {
  const encode = encodeFunctionData as unknown as (input: {
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }) => Hex;
  const data = encode({
    abi: args.abi,
    functionName: args.functionName,
    args: args.callArgs,
  });
  const signer = walletClient as {
    account: unknown;
    prepareTransactionRequest(args: Record<string, unknown>): Promise<{ nonce: bigint } & Record<string, unknown>>;
    signTransaction(args: Record<string, unknown>): Promise<Hex>;
  };
  const request = await signer.prepareTransactionRequest({
    account: signer.account,
    to: args.address,
    data,
    nonce: args.nonce,
    ...(args.value !== undefined ? { value: args.value } : {}),
    ...(args.gas !== undefined ? { gas: args.gas } : {}),
  });
  const serialized = await signer.signTransaction(request);
  return {
    hash: keccak256(serialized),
    intentHash: contractWriteIntentHash(args.address, args.value ?? 0n, data),
    serialized,
    nonce: args.nonce,
  };
}

function contractWriteIntentHash(address: Hex, value: bigint, data: Hex): Hex {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("address, uint256, bytes"),
    [address, value, data],
  ));
}

function bumpedFee(value: bigint, percent: number): bigint {
  const proportional = (value * BigInt(100 + percent) + 99n) / 100n;
  return proportional > value + 1_000_000_000n
    ? proportional
    : value + 1_000_000_000n;
}

/** Re-signs identical call intent at the original nonce with bounded fees. */
export async function prepareSignedFeeReplacement(args: {
  serialized: Hex;
  nonce: bigint;
  expectedIntentHash: Hex;
  feeBumpPercent: number;
  maxFeePerGas: bigint;
}): Promise<{ hash: Hex; intentHash: Hex; serialized: Hex; nonce: bigint }> {
  const transaction = parseTransaction(args.serialized);
  if (
    !transaction.to
    || transaction.nonce === undefined
    || BigInt(transaction.nonce) !== args.nonce
  ) {
    throw new Error("Stored provider write cannot be used for same-nonce replacement");
  }
  const data = transaction.data ?? "0x";
  const value = transaction.value ?? 0n;
  const intentHash = contractWriteIntentHash(transaction.to, value, data);
  if (intentHash.toLowerCase() !== args.expectedIntentHash.toLowerCase()) {
    throw new Error("Stored provider write intent does not match its ledger hash");
  }
  const feeFields: Record<string, bigint> = {};
  if (transaction.maxFeePerGas !== undefined) {
    const maxFee = bumpedFee(transaction.maxFeePerGas, args.feeBumpPercent);
    const priority = bumpedFee(
      transaction.maxPriorityFeePerGas ?? 0n,
      args.feeBumpPercent,
    );
    if (maxFee > args.maxFeePerGas || priority > args.maxFeePerGas) {
      throw new Error("Provider write fee replacement exceeds the configured ceiling");
    }
    feeFields.maxFeePerGas = maxFee;
    feeFields.maxPriorityFeePerGas = priority;
  } else if (transaction.gasPrice !== undefined) {
    const gasPrice = bumpedFee(transaction.gasPrice, args.feeBumpPercent);
    if (gasPrice > args.maxFeePerGas) {
      throw new Error("Provider write fee replacement exceeds the configured ceiling");
    }
    feeFields.gasPrice = gasPrice;
  } else {
    throw new Error("Stored provider write has no replaceable fee fields");
  }
  const signer = walletClient as {
    account: unknown;
    prepareTransactionRequest(
      args: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
    signTransaction(args: Record<string, unknown>): Promise<Hex>;
  };
  const request = await signer.prepareTransactionRequest({
    account: signer.account,
    to: transaction.to,
    data,
    value,
    gas: transaction.gas,
    nonce: args.nonce,
    ...feeFields,
  });
  const serialized = await signer.signTransaction(request);
  return {
    hash: keccak256(serialized),
    intentHash,
    serialized,
    nonce: args.nonce,
  };
}

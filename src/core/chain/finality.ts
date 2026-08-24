import type { Hex } from "viem";
import { config } from "../config.js";
import { publicClient } from "./client.js";

export interface CanonicalReceipt {
  status: "success" | "reverted";
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
}

export async function assertCanonicalFinalReceipt(
  receipt: CanonicalReceipt,
  expectedHash: Hex,
): Promise<void> {
  if (receipt.transactionHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error("Receipt transaction hash does not match the submitted transaction");
  }
  const latest = await publicClient.getBlockNumber() as bigint;
  const confirmations = latest >= receipt.blockNumber ? latest - receipt.blockNumber + 1n : 0n;
  if (confirmations < BigInt(config.CHAIN_WRITE_FINALITY_CONFIRMATIONS)) {
    throw new Error(
      `Transaction has ${confirmations} confirmation(s); `
      + `${config.CHAIN_WRITE_FINALITY_CONFIRMATIONS} required`,
    );
  }
  const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
  if (!canonical.hash || canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new Error("Transaction receipt is no longer in the canonical chain");
  }
}

export async function waitForCanonicalFinalReceipt(hash: Hex): Promise<CanonicalReceipt> {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: config.CHAIN_WRITE_FINALITY_CONFIRMATIONS,
  }) as CanonicalReceipt;
  await assertCanonicalFinalReceipt(receipt, hash);
  return receipt;
}

export async function finalizedReadBlockNumber(): Promise<bigint> {
  const latest = await publicClient.getBlockNumber() as bigint;
  const depth = BigInt(config.CHAIN_WRITE_FINALITY_CONFIRMATIONS);
  if (latest + 1n < depth) throw new Error("Chain has not reached the configured finality depth");
  return latest - depth + 1n;
}

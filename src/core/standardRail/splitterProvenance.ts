import {
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import type { ProviderOutcomeConfig } from "./types.js";

export const splitterFactoryAbi = parseAbi([
  "function deploy(bytes32 salt,uint256 canonicalChainId,address canonicalToken,address providerPayee,address daskiCommissionReceiver,uint16 commissionBps,bytes32 policyVersionHash,bytes32 outcomeIdHash,bytes32 listingCommitmentHash,uint64 listingEpoch) returns (address splitter)",
  "event OutcomeSplitterDeployed(address indexed splitter,bytes32 indexed salt,bytes32 indexed outcomeIdHash,uint64 listingEpoch,bytes32 listingCommitmentHash)",
]);

export const splitterEvidenceAbi = parseAbi([
  "function canonicalChainId() view returns (uint256)",
  "function canonicalToken() view returns (address)",
  "function providerPayee() view returns (address)",
  "function daskiCommissionReceiver() view returns (address)",
  "function commissionBps() view returns (uint16)",
  "function policyVersionHash() view returns (bytes32)",
  "function outcomeIdHash() view returns (bytes32)",
  "function listingCommitmentHash() view returns (bytes32)",
  "function listingEpoch() view returns (uint64)",
  "function releaseSequence() view returns (uint64)",
  "event Released(bytes32 indexed outcomeIdHash,uint64 indexed listingEpoch,uint64 indexed releaseSequence,bytes32 policyVersionHash,bytes32 listingCommitmentHash,uint256 grossAmount,uint256 providerNetAmount,uint256 daskiCommissionAmount)",
]);

interface SplitterDeploymentEvent {
  emitter: Address;
  splitter: Address;
  salt: Hex;
  outcomeIdHash: Hex;
  listingEpoch: bigint;
  listingCommitmentHash: Hex;
}

export interface SplitterDeploymentObservation {
  receiptStatus: "success" | "reverted";
  receiptTransactionHash: Hex;
  receiptBlockNumber: bigint;
  receiptBlockHash: Hex;
  transactionHash: Hex;
  transactionTo: Address | null;
  transactionValue: bigint;
  transactionInput: Hex;
  transactionBlockNumber: bigint | null;
  transactionBlockHash: Hex | null;
  factoryRuntimeCodeHash: Hex;
  splitterRuntimeCodeHash: Hex;
  events: readonly SplitterDeploymentEvent[];
  immutables: {
    canonicalChainId: bigint;
    canonicalToken: Address;
    providerPayee: Address;
    daskiCommissionReceiver: Address;
    commissionBps: number;
    policyVersionHash: Hex;
    outcomeIdHash: Hex;
    listingCommitmentHash: Hex;
    listingEpoch: bigint;
  };
}

export function expectedSplitterDeploymentInput(
  outcome: ProviderOutcomeConfig,
  chainId: number,
): Hex {
  return encodeFunctionData({
    abi: splitterFactoryAbi,
    functionName: "deploy",
    args: [
      outcome.splitterDeploymentSalt,
      BigInt(chainId),
      getAddress(outcome.token),
      getAddress(outcome.providerPayee),
      getAddress(outcome.daskiCommissionReceiver),
      outcome.commissionBps,
      outcome.policyVersionHash,
      outcome.outcomeIdHash,
      outcome.listingCommitmentHash,
      BigInt(outcome.listingEpoch),
    ],
  });
}

export function assertSplitterDeploymentProvenance(
  outcome: ProviderOutcomeConfig,
  chainId: number,
  observed: SplitterDeploymentObservation,
): SplitterDeploymentObservation {
  const deploymentBlock = BigInt(outcome.splitterDeploymentBlockNumber);
  const matchingEvents = observed.events.filter((event) =>
    getAddress(event.emitter) === getAddress(outcome.splitterFactory) &&
    getAddress(event.splitter) === getAddress(outcome.splitter) &&
    event.salt.toLowerCase() === outcome.splitterDeploymentSalt.toLowerCase() &&
    event.outcomeIdHash.toLowerCase() === outcome.outcomeIdHash.toLowerCase() &&
    event.listingEpoch === BigInt(outcome.listingEpoch) &&
    event.listingCommitmentHash.toLowerCase() === outcome.listingCommitmentHash.toLowerCase()
  );
  const immutables = observed.immutables;
  if (
    observed.receiptStatus !== "success" ||
    observed.receiptTransactionHash.toLowerCase() !==
      outcome.splitterDeploymentTransaction.toLowerCase() ||
    observed.transactionHash.toLowerCase() !== outcome.splitterDeploymentTransaction.toLowerCase() ||
    observed.receiptBlockNumber !== deploymentBlock ||
    observed.receiptBlockHash.toLowerCase() !== outcome.splitterDeploymentBlockHash.toLowerCase() ||
    observed.transactionBlockNumber !== deploymentBlock ||
    observed.transactionBlockHash?.toLowerCase() !== outcome.splitterDeploymentBlockHash.toLowerCase() ||
    observed.transactionTo === null ||
    getAddress(observed.transactionTo) !== getAddress(outcome.splitterFactory) ||
    observed.transactionValue !== 0n ||
    observed.transactionInput.toLowerCase() !==
      expectedSplitterDeploymentInput(outcome, chainId).toLowerCase() ||
    observed.factoryRuntimeCodeHash.toLowerCase() !==
      outcome.splitterFactoryRuntimeCodeHash.toLowerCase() ||
    observed.splitterRuntimeCodeHash.toLowerCase() !== outcome.splitterRuntimeCodeHash.toLowerCase() ||
    matchingEvents.length !== 1 ||
    immutables.canonicalChainId !== BigInt(chainId) ||
    getAddress(immutables.canonicalToken) !== getAddress(outcome.token) ||
    getAddress(immutables.providerPayee) !== getAddress(outcome.providerPayee) ||
    getAddress(immutables.daskiCommissionReceiver) !== getAddress(outcome.daskiCommissionReceiver) ||
    immutables.commissionBps !== outcome.commissionBps ||
    immutables.policyVersionHash.toLowerCase() !== outcome.policyVersionHash.toLowerCase() ||
    immutables.outcomeIdHash.toLowerCase() !== outcome.outcomeIdHash.toLowerCase() ||
    immutables.listingCommitmentHash.toLowerCase() !== outcome.listingCommitmentHash.toLowerCase() ||
    immutables.listingEpoch !== BigInt(outcome.listingEpoch)
  ) throw new Error("Splitter factory deployment provenance mismatch");
  return observed;
}

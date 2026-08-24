import type { Hex } from "viem";
import type { ProviderOutcomeConfig } from "./types.js";

export interface ActivationObservation {
  blockNumber: string;
  blockHash: Hex;
  position: "END_OF_BLOCK";
  tokenBalance: string;
  releaseSequence: string;
  tokenCodeHash: Hex;
  splitterCodeHash: Hex;
  factoryCodeHash: Hex;
}

export function assertActivationCheckpoint(
  outcome: ProviderOutcomeConfig,
  observed: ActivationObservation,
): ActivationObservation {
  if (
    outcome.splitterActivationPosition !== "END_OF_BLOCK" ||
    observed.position !== "END_OF_BLOCK" ||
    observed.blockNumber !== outcome.splitterActivationBlockNumber ||
    observed.blockHash.toLowerCase() !== outcome.splitterActivationBlockHash.toLowerCase() ||
    observed.tokenBalance !== outcome.splitterStartingTokenBalance ||
    observed.releaseSequence !== outcome.splitterStartingReleaseSequence ||
    observed.tokenCodeHash.toLowerCase() !== outcome.tokenRuntimeCodeHash.toLowerCase() ||
    observed.splitterCodeHash.toLowerCase() !== outcome.splitterRuntimeCodeHash.toLowerCase() ||
    observed.factoryCodeHash.toLowerCase() !== outcome.splitterFactoryRuntimeCodeHash.toLowerCase()
  ) {
    throw new Error("Splitter activation checkpoint mismatch");
  }
  return observed;
}

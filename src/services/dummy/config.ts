import { config as coreConfig } from "../../core/config.js";

export const DUMMY_SLUG = "dummy";
export const DUMMY_OUTCOME_ID = "dummy-create-note";
export const NOTE_ASSET_TYPE = "note";

/// Retail price of create-note in atomic USDC (6 decimals): $0.10.
export const NOTE_PRICE_ATOMIC = "100000";

export function assertDummyServiceAllowed(chainId: number): void {
  if (chainId === 8453) {
    throw new Error("Replace the dummy service before deploying on Base mainnet");
  }
}

// The starter service is always installed for local development and Base
// Sepolia. A production provider must replace it with a real service.
assertDummyServiceAllowed(coreConfig.CHAIN_ID);

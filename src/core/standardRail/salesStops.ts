import type { Hex } from "viem";

/** Why new sales of a listing version are stopped while servicing continues. */
export type SalesStopReason = "contract_drift";

const stops = new Map<string, SalesStopReason>();

/**
 * Stop new quotes for one listing version. Funded orders, status and
 * lifecycle reads are unaffected: only the readiness quote consults this.
 */
export function stopNewSales(listingManifestHash: Hex, reason: SalesStopReason): void {
  stops.set(listingManifestHash.toLowerCase(), reason);
}

export function salesStopFor(listingManifestHash: Hex): SalesStopReason | null {
  return stops.get(listingManifestHash.toLowerCase()) ?? null;
}

export function clearSalesStopsForTests(): void {
  stops.clear();
}

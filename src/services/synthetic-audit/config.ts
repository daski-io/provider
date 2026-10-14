export const SYNTHETIC_AUDIT_SLUG = "synthetic-audit";
export const AUDIT_SKILL_ID = "audit";
export const AUDIT_PRICE_ATOMIC = "500000";
/** The adapter version: how this service's job references are read. */
export const AUDIT_ADAPTER_VERSION = "audit-v1";
/** The synthetic product's audit runs eight hours. */
export const AUDIT_RUNTIME_SECONDS = 8 * 3_600;
/** The declared fulfillment window: runtime, queue delay, retries and report retrieval. */
export const AUDIT_FULFILLMENT_SECONDS = 12 * 3_600;
/** The synthetic product's documented same-key replay guarantee. */
export const AUDIT_IDEMPOTENCY_RETENTION_SECONDS = 24 * 3_600;
/** How long the product asks callers to wait between report polls. */
export const AUDIT_POLL_AFTER_SECONDS = 1_800;
/** The reviewed product endpoint every stored report URL must stay under. */
export const AUDIT_REVIEWED_ENDPOINT = "https://audit.example/v1";

/** The synthetic audit is a Testnet example with a fake upstream; it never runs on Base Mainnet. */
export function assertSyntheticAuditAllowed(chainId: number): void {
  if (chainId === 8453) {
    throw new Error("The synthetic audit example must not be installed on Base mainnet");
  }
}

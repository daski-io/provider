import { createHash } from "node:crypto";
import { canonicalJson } from "../standardRail/canonical.js";

/** What one external job's stable operation identity is derived from. */
export interface JobOperationIdentity {
  /** The admitted Daski environment and chain (testnet/mainnet, chain id). */
  environment: string;
  chainId: number;
  /** This provider's ERC-8004 agent id: its stable identity across wallet or origin moves. */
  providerAgentId: string;
  gatewayAudience: string;
  orderId: string;
  serviceSlug: string;
  skillId: string;
}

const DERIVATION = "daski-external-job-idempotency/v1";

/**
 * The stable idempotency key of an order's upstream start: SHA-256 over the
 * canonical JSON of the admitted environment and chain, provider identity,
 * gateway audience, order, service, skill and the operation ("start"),
 * formatted as an RFC 9562 version-8 UUID (36 characters, accepted by most
 * products' idempotency headers). It is computed once at admission and
 * persisted with the job before any call; retries, restarts and upgrades
 * reuse the stored value. Attempts, processes and times never enter it.
 */
export function externalJobIdempotencyKey(identity: JobOperationIdentity): string {
  const digest = createHash("sha256").update(canonicalJson({
    derivation: DERIVATION,
    environment: identity.environment,
    chainId: identity.chainId,
    providerAgentId: identity.providerAgentId,
    gatewayAudience: identity.gatewayAudience,
    orderId: identity.orderId,
    serviceSlug: identity.serviceSlug,
    skillId: identity.skillId,
    operation: "start",
  }), "utf8").digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

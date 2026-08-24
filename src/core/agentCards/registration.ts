import type { ServiceRow } from "../db/queries/services.js";
import { config } from "../config.js";

/**
 * ERC-8004 agent registration file.
 * Pinned to draft spec commit 503591a6e80e6e1affdd6403341e25269141f046.
 * Shape: https://eips.ethereum.org/EIPS/eip-8004#registration-v1
 *
 * `type`/`name`/`description`/`image` mirror the ERC-721 metadata
 * convention so identity-registry NFT viewers can render the provider
 * straight from this file. `external_url` is not in the strict ERC-8004
 * schema but is the universally-recognized ERC-721/OpenSea field for a
 * project's homepage — we emit it when PROVIDER_WEBSITE_URL is set so
 * NFT-aware indexers pick it up without a Daski-specific extension.
 */
export interface AgentRegistrationFile {
  type: string;
  name: string;
  legalName: string;
  termsUrl: string;
  privacyUrl: string;
  description?: string;
  image?: string;
  external_url?: string;
  services: Array<{ name: string; endpoint: string; version?: string }>;
  x402Support: boolean;
  active: boolean;
  registrations: Array<{ agentId: string; agentRegistry: string }>;
  supportedTrust?: string[];
}

/**
 * Builds the ERC-8004 registration file for the provider.
 *
 * Top-level `name`/`description` describe the *provider* (the operating
 * entity), driven by PROVIDER_NAME / PROVIDER_DESCRIPTION env. Per-service
 * name/description live in each service's A2A AgentCard at
 * /agent-cards/<slug>.json — linked here via ONE `services[name="A2A"]`
 * entry PER ACTIVE SERVICE. The gateway's discovery cache fetches every
 * A2A entry and surfaces one catalog entry per service, so a
 * multi-service provider is fully discoverable from this single file.
 */
export function generateRegistrationFile(
  services: ServiceRow[],
  opts: {
    /** EIP-155-style registry identifier, e.g. `eip155:84532:0x…` */
    agentRegistry: string;
  },
): AgentRegistrationFile {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: config.PROVIDER_NAME,
    legalName: config.PROVIDER_NAME,
    termsUrl: config.PROVIDER_TERMS_URL,
    privacyUrl: config.PROVIDER_PRIVACY_URL,
    ...(config.PROVIDER_DESCRIPTION
      ? { description: config.PROVIDER_DESCRIPTION }
      : {}),
    ...(config.PROVIDER_ICON_URL ? { image: config.PROVIDER_ICON_URL } : {}),
    ...(config.PROVIDER_WEBSITE_URL
      ? { external_url: config.PROVIDER_WEBSITE_URL }
      : {}),
    services: [{
      name: "MCP",
      endpoint: `${config.GATEWAY_BASE_URL!.replace(/\/$/, "")}/mcp`,
      version: "2025-11-25",
    }, ...services.map((service) => ({
          name: "A2A",
          endpoint: `${config.BASE_URL}/agent-cards/${service.slug}.json`,
          version: "1.0.0",
        }))],
    x402Support: true,
    active: services.some((s) => s.is_active),
    registrations: [
      {
        // v4: provider agentId is constant across services and lives in env.
        agentId: config.PROVIDER_AGENT_ID.toString(),
        agentRegistry: opts.agentRegistry,
      },
    ],
    supportedTrust: ["reputation"],
  };
}

/**
 * Builds the `agentRegistry` colon-separated identifier per ERC-8004 §Identity
 * Registry. We use EIP-155 for EVM chains, followed by chainId and registry
 * address.
 */
export function buildAgentRegistryId(
  chainId: number,
  identityRegistryAddress: string,
): string {
  return `eip155:${chainId}:${identityRegistryAddress.toLowerCase()}`;
}

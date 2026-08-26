import { config } from "../config.js";
import type { ServiceModule } from "../serviceRegistry/types.js";

export function buildAgentRegistryId(chainId: number, registry: string): string {
  return `eip155:${chainId}:${registry.toLowerCase()}`;
}

export function generateRegistrationFile(services: ServiceModule[]) {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: config.PROVIDER_NAME,
    legalName: config.PROVIDER_NAME,
    termsUrl: config.PROVIDER_TERMS_URL,
    privacyUrl: config.PROVIDER_PRIVACY_URL,
    ...(config.PROVIDER_DESCRIPTION ? { description: config.PROVIDER_DESCRIPTION } : {}),
    ...(config.PROVIDER_ICON_URL ? { image: config.PROVIDER_ICON_URL } : {}),
    ...(config.PROVIDER_WEBSITE_URL ? { external_url: config.PROVIDER_WEBSITE_URL } : {}),
    services: [{
      name: "MCP",
      endpoint: `${config.GATEWAY_BASE_URL.replace(/\/$/, "")}/mcp`,
      version: "2025-11-25",
    }, ...services.map((service) => ({
      name: "A2A",
      endpoint: `${config.BASE_URL}/agent-cards/${service.manifest.slug}.json`,
      version: "1.0.0",
    }))],
    x402Support: true,
    active: services.length > 0,
    registrations: [{
      agentId: config.PROVIDER_AGENT_ID.toString(),
      agentRegistry: buildAgentRegistryId(
        config.CHAIN_ID,
        config.IDENTITY_REGISTRY_ADDRESS,
      ),
    }],
    supportedTrust: ["reputation"],
  };
}

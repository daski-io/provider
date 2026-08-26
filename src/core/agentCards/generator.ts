import { config } from "../config.js";
import type { ServiceModule } from "../serviceRegistry/types.js";
import type { AgentCard } from "./types.js";

const DASKI_EXTENSION = "https://daski.xyz/a2a/v1";

export function generateAgentCard(service: ServiceModule): AgentCard {
  const slug = service.manifest.slug;
  return {
    name: service.manifest.name,
    description: service.manifest.description,
    version: service.manifest.version,
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    supportedInterfaces: [{
      url: `${config.BASE_URL}/standard-rail`,
      protocolBinding: "HTTP+JSON",
      protocolVersion: "2",
    }],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [{
        uri: DASKI_EXTENSION,
        description:
          "Daski standard-rail discovery, fixed pricing, and synchronous fulfillment metadata.",
        required: false,
      }],
    },
    skills: service.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: [...(service.manifest.tags ?? []), ...(skill.tags ?? [])],
      examples: skill.examples,
      documentationUrl: `${config.BASE_URL}/skills/${slug}/${skill.id}.md`,
    })),
    documentationUrl: `${config.BASE_URL}/skills/${slug}.md`,
    extensions: {
      [DASKI_EXTENSION]: {
        providerAgentId: config.PROVIDER_AGENT_ID.toString(),
        standardRailOnly: true,
        dispatchMode: "one-shot",
        fulfillmentMode: "automated",
        categoryFamily: service.manifest.categoryFamily,
        serviceType: service.manifest.serviceType,
        jurisdictions: service.manifest.jurisdictions,
        turnaroundEstimate: service.manifest.turnaroundEstimate,
        pricing: Object.fromEntries(service.skills.map((skill) => [
          skill.id,
          { USDC: { type: "one-time", fixedAmount: skill.fixedPriceAtomic } },
        ])),
        legal: {
          marketplaceTermsUrl: config.MARKETPLACE_TERMS_URL,
          marketplacePrivacyUrl: config.MARKETPLACE_PRIVACY_URL,
          providerTermsUrl: config.PROVIDER_TERMS_URL,
          providerPrivacyUrl: config.PROVIDER_PRIVACY_URL,
        },
        support: {
          email: config.SUPPORT_EMAIL,
          responseSla: config.SUPPORT_RESPONSE_SLA,
        },
      },
    },
  };
}

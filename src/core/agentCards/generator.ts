import { config } from "../config.js";
import type { ServiceModule } from "../serviceRegistry/types.js";
import type { AgentCard } from "./types.js";
import type { Hex } from "viem";
import {
  buildContractExtension,
  DASKI_CONTRACT_EXTENSION_URI,
} from "./contractExtension.js";

const DASKI_EXTENSION = "https://daski.io/a2a/v1";

export function generateAgentCard(
  service: ServiceModule,
  serviceId: Hex | null = null,
): AgentCard {
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
          "Daski marketplace service, pricing, legal, and support metadata.",
        required: false,
      }, {
        uri: DASKI_CONTRACT_EXTENSION_URI,
        description:
          "Daski provider-driven service and skill contracts with closed schemas and fixed pricing.",
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
          providerLegalName: config.PROVIDER_NAME,
          providerTermsUrl: config.PROVIDER_TERMS_URL,
          providerPrivacyUrl: config.PROVIDER_PRIVACY_URL,
        },
        support: {
          email: config.SUPPORT_EMAIL,
          responseSla: config.SUPPORT_RESPONSE_SLA,
        },
      },
      [DASKI_CONTRACT_EXTENSION_URI]:
        buildContractExtension(service, config.BASE_URL, serviceId),
    },
  };
}

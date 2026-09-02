import { describe, expect, it } from "vitest";
import { generateAgentCard } from "../src/core/agentCards/generator.js";
import {
  buildAgentRegistryId,
  generateRegistrationFile,
} from "../src/core/agentCards/registration.js";
import { dummyService } from "../src/services/dummy/index.js";

describe("provider discovery", () => {
  it("advertises only the synchronous standard-rail interface", () => {
    const card = generateAgentCard(dummyService);
    expect(card.supportedInterfaces).toEqual([{
      url: "https://provider.test/standard-rail",
      protocolBinding: "HTTP+JSON",
      protocolVersion: "2",
    }]);
    expect(card.capabilities).toMatchObject({
      streaming: false,
      pushNotifications: false,
    });
    expect(card.skills).toHaveLength(1);
    expect(card.extensions["https://daski.io/a2a/v1"]).toMatchObject({
      standardRailOnly: true,
      dispatchMode: "one-shot",
      fulfillmentMode: "automated",
      legal: { providerLegalName: "Test Provider" },
    });
    expect(card.extensions["https://daski.io/a2a/v2"]).toMatchObject({
      schemaVersion: 1,
      service: { slug: "dummy", lifecycle: "one-shot" },
      skills: [{
        skillId: "echo",
        acceptingNewOrders: true,
        contract: {
          paymentRequired: true,
          inputSchema: { additionalProperties: false },
          resultSchema: { additionalProperties: false },
        },
      }],
    });
  });

  it("emits one provider identity and gateway MCP discovery", () => {
    const registration = generateRegistrationFile([dummyService]);
    expect(registration.services[0]).toMatchObject({
      name: "MCP",
      endpoint: "https://gateway.test/mcp",
    });
    expect(registration.services[1]).toMatchObject({
      name: "A2A",
      endpoint: "https://provider.test/agent-cards/dummy.json",
    });
    expect(registration.registrations).toEqual([{
      agentId: "1",
      agentRegistry: buildAgentRegistryId(
        84532,
        "0x1111111111111111111111111111111111111111",
      ),
    }]);
  });
});

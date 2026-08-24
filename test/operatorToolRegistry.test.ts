import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  services: [] as Array<Record<string, unknown>>,
  screeningTools: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAllServices: () => state.services,
}));
vi.mock("../src/core/screening/registry.js", () => ({
  getScreeningExtension: () => state.screeningTools.length > 0
    ? { operatorTools: () => state.screeningTools }
    : null,
}));

import { validateOperatorAgentTools } from "../src/core/agents/operatorAgent/tools.js";

function tool(name: string) {
  return {
    definition: { type: "function", function: { name, description: "test", parameters: {} } },
    execute: async () => "{}",
  };
}

function service(slug: string, readNames: string[], actionNames: string[]) {
  return {
    manifest: { slug },
    agents: {
      operatorAgentTools: () => readNames.map(tool),
      operatorAgentActionTools: () => actionNames.map(tool),
    },
  };
}

describe("operator tool registry", () => {
  beforeEach(() => {
    state.services = [];
    state.screeningTools = [];
  });

  it("accepts uniquely classified provider tools", () => {
    state.services.push(service("service-a", ["service_read"], ["service_action"]));
    state.screeningTools.push(tool("screening_action"));
    expect(() => validateOperatorAgentTools()).not.toThrow();
  });

  it("rejects built-in, cross-service, and cross-class collisions", () => {
    state.services.push(service("service-a", ["list_services"], []));
    expect(() => validateOperatorAgentTools()).toThrow(/collision/i);

    state.services = [service("service-a", ["same_name"], ["same_name"])];
    expect(() => validateOperatorAgentTools()).toThrow(/collision/i);

    state.services = [
      service("service-a", ["shared_name"], []),
      service("service-b", [], ["shared_name"]),
    ];
    expect(() => validateOperatorAgentTools()).toThrow(/collision/i);
  });
});

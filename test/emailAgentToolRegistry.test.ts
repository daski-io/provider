import { describe, it, expect, beforeEach, vi } from "vitest";

// The registry collects shared + per-service Email Agent tools and scopes
// them to a service at triage time. getAllServices is the only thing
// toolRegistry pulls from the service registry, so we mock just that.

const fakeModules: Array<{
  manifest: { slug: string };
  agents?: { emailAgentTools?: () => unknown[] };
}> = [];
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAllServices: () => fakeModules,
}));

import {
  toolsForService,
  validateEmailAgentTools,
} from "../src/core/agents/emailAgent/toolRegistry.js";
import { SHARED_TOOLS } from "../src/core/agents/emailAgent/tools/index.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakeTool(name: string, scope?: "all" | string[]): any {
  return {
    definition: { type: "function", function: { name, description: "", parameters: {} } },
    scope,
    execute: async () => "{}",
  };
}
function fakeModule(slug: string, tools: any[]) {
  return { manifest: { slug }, agents: { emailAgentTools: () => tools } };
}
const names = (slug: string) =>
  toolsForService(slug).map((t) => t.definition.function.name);

describe("email agent tool registry", () => {
  beforeEach(() => {
    fakeModules.length = 0;
  });

  it("shows the shared tools for every service", () => {
    fakeModules.push(fakeModule("svc-a", []));
    const visible = names("svc-a");
    for (const s of SHARED_TOOLS) {
      expect(visible).toContain(s.definition.function.name);
    }
  });

  it("scopes a service's tools to that service (default scope = own slug)", () => {
    fakeModules.push(fakeModule("svc-a", [fakeTool("a_only")]));
    fakeModules.push(fakeModule("svc-b", [fakeTool("b_only")]));
    expect(names("svc-a")).toContain("a_only");
    expect(names("svc-a")).not.toContain("b_only");
    expect(names("svc-b")).toContain("b_only");
    expect(names("svc-b")).not.toContain("a_only");
  });

  it("honors an explicit multi-service scope", () => {
    fakeModules.push(fakeModule("svc-a", [fakeTool("multi", ["svc-a", "svc-b"])]));
    expect(names("svc-a")).toContain("multi");
    expect(names("svc-b")).toContain("multi");
    expect(names("svc-c")).not.toContain("multi");
  });

  it("throws on a name collision within a service's resolvable set", () => {
    // 'classify' is a shared tool; a service re-declaring it would shadow.
    fakeModules.push(fakeModule("svc-a", [fakeTool("classify")]));
    expect(() => validateEmailAgentTools()).toThrow(/collision/i);
  });

  it("passes validation when every name is unique", () => {
    fakeModules.push(fakeModule("svc-a", [fakeTool("a_only")]));
    fakeModules.push(fakeModule("svc-b", [fakeTool("b_only")]));
    expect(() => validateEmailAgentTools()).not.toThrow();
  });
});

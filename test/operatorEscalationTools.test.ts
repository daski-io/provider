import { describe, expect, it } from "vitest";
import {
  ESCALATION_AUTONOMOUS_TOOLS,
  ESCALATION_HUMAN_TOOLS,
  FREE_FORM_TOOLS,
} from "../src/core/agents/operatorAgent/tools.js";

function names(tools: typeof FREE_FORM_TOOLS): string[] {
  return tools.map((tool) => tool.definition.function.name);
}

describe("operator escalation inspection surface", () => {
  it.each([
    ["free-form", FREE_FORM_TOOLS],
    ["autonomous", ESCALATION_AUTONOMOUS_TOOLS],
    ["human escalation", ESCALATION_HUMAN_TOOLS],
  ])("includes get_review exactly once in %s mode", (_mode, tools) => {
    expect(names(tools).filter((name) => name === "get_review")).toHaveLength(1);
    expect(new Set(names(tools)).size).toBe(names(tools).length);
  });

  it("does not expose global customer or queue discovery to autonomous escalations", () => {
    expect(names(ESCALATION_AUTONOMOUS_TOOLS)).not.toContain("list_transactions");
    expect(names(ESCALATION_AUTONOMOUS_TOOLS)).not.toContain("get_transaction");
    expect(names(ESCALATION_AUTONOMOUS_TOOLS)).not.toContain("list_open_reviews");
    expect(names(ESCALATION_AUTONOMOUS_TOOLS)).not.toContain("list_service_rules");
  });

  it("exposes operational recovery actions only in a human Review", () => {
    const reviewOnly = [
      "replace_provider_write_fee",
      "reconcile_reputation_outcome",
      "retry_reputation_outcome_once",
      "abort_reputation_outcome",
      "retry_stalled_automation",
    ];
    for (const name of reviewOnly) {
      expect(names(FREE_FORM_TOOLS)).not.toContain(name);
      expect(names(ESCALATION_HUMAN_TOOLS)).toContain(name);
    }
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// e2f attempt 1 on 2026-07-24 failed because the pre-execute LLM stalled at
// exactly the configured timeout and the fail-closed policy parked a PAID
// request for human review. A platform hiccup reported identically to a
// product defect, with the buyer's USDC behind it. There was no retry — one
// Promise.race and straight to the escalation.

const state = vi.hoisted(() => ({
  completions: [] as Array<() => Promise<string>>,
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/core/llm/openai.js", () => ({
  OpenAIClient: class {
    async completeJson(): Promise<string> {
      const next = state.completions.shift();
      if (!next) throw new Error("no queued completion");
      return next();
    }
  },
}));
vi.mock("../src/core/db/queries/serviceRules.js", () => ({
  listActiveRulesForLlm: vi.fn(async () => []),
}));
vi.mock("../src/core/events/emitter.js", () => ({
  emitEvent: vi.fn(async (e: Record<string, unknown>) => {
    state.events.push(e);
  }),
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getService: vi.fn(() => null),
}));
vi.mock("../src/core/engine/taskManager.js", () => ({ transitionTask: vi.fn() }));
vi.mock("../src/core/engine/escalation.js", () => ({ markEscalated: vi.fn() }));
vi.mock("../src/core/engine/autoRefund.js", () => ({
  refundSettledTransaction: vi.fn(),
}));
vi.mock("../src/core/config.js", () => ({
  config: { LLM_MODEL: "test-model" },
}));

import { consultPreExecuteAgent } from "../src/core/engine/preExecuteRunner.js";

const service = { id: "svc-1", slug: "sample-service" } as never;

function skill(onError: "proceed" | "escalate") {
  return {
    skill_id: "create-record",
    config: {
      llm: {
        enabled: true,
        model: "test-model",
        timeout_ms: 40,
        on_error: onError,
        default_system_prompt: "review",
        default_escalation_rules: "",
      },
    },
  } as never;
}

const stall = () => new Promise<string>(() => {});
const answer = (json: string) => async () => json;

beforeEach(() => {
  state.completions = [];
  state.events = [];
});

describe("pre-execute timeout retry", () => {
  it("retries once and uses the second answer instead of failing closed", async () => {
    state.completions = [stall, answer('{"decision":"proceed"}')];

    const decision = await consultPreExecuteAgent(
      service,
      skill("escalate"),
      { itemName: "Retry Item" },
      true,
      "task-1",
    );

    expect(decision).toEqual({ action: "proceed" });
    expect(state.completions).toHaveLength(0);
    expect(state.events.map((e) => e.type)).toContain(
      "llm.preexecute.timeout_retry",
    );
    expect(state.events.map((e) => e.type)).not.toContain("llm.preexecute.error");
  });

  it("still fails closed when the retry also times out", async () => {
    state.completions = [stall, stall];

    const decision = await consultPreExecuteAgent(
      service,
      skill("escalate"),
      { itemName: "Stuck Item" },
      true,
      "task-2",
    );

    expect(decision.action).toBe("escalate");
    expect(state.events.map((e) => e.type)).toContain("llm.preexecute.error");
  });

  it("does not retry a fail-open skill — a timeout there just proceeds", async () => {
    state.completions = [stall, answer('{"decision":"escalate"}')];

    const decision = await consultPreExecuteAgent(
      service,
      skill("proceed"),
      { reference: "sample-item" },
      true,
      "task-3",
    );

    expect(decision).toEqual({ action: "proceed" });
    // The second queued completion was never consumed.
    expect(state.completions).toHaveLength(1);
    expect(state.events.map((e) => e.type)).not.toContain(
      "llm.preexecute.timeout_retry",
    );
  });
});

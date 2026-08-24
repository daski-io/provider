import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  history: [] as Array<Record<string, unknown>>,
  tools: [] as Array<Record<string, unknown>>,
  appended: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));
vi.mock("../src/core/config.js", () => ({
  config: {
    OPENAI_API_KEY: "test",
    OUTBOUND_TOTAL_TIMEOUT_MS: 1_000,
    OPERATOR_AGENT_LLM_MODEL: "test-model",
    LLM_MODEL: "test-model",
  },
}));
vi.mock("../src/core/db/queries/operatorChats.js", () => ({
  listChatThreadMessages: vi.fn(async () => state.history),
  appendOperatorChatMessage: vi.fn(async (args: Record<string, unknown>) => {
    state.appended.push(args);
    return { id: `chat-${state.appended.length}`, ...args };
  }),
}));
vi.mock("../src/core/db/queries/chatThreads.js", () => ({
  touchChatThread: vi.fn(),
}));
vi.mock("../src/core/agents/operatorAgent/tools.js", () => ({
  toolsForMode: () => state.tools,
}));
vi.mock("../src/core/agents/operatorAgent/prompt.js", () => ({
  buildSystemPrompt: ({ escalationContext }: { escalationContext?: string }) =>
    `SYSTEM\n${escalationContext ?? ""}`,
}));
vi.mock("../src/core/events/emitter.js", () => ({ emitEvent: vi.fn() }));

import { runOperatorLoop } from "../src/core/agents/operatorAgent/index.js";

const pii = {
  email: "sentinel.person@example.com",
  ssn: "123-45-6789",
  dob: "1990-01-02",
  address: "123 Sentinel Street",
  name: "Jane Sentinel",
};

function finalResponse(text = "done") {
  return { choices: [{ message: { content: text, tool_calls: undefined } }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.history = [];
  state.tools = [];
  state.appended = [];
});

describe("operator external-model boundary", () => {
  it("redacts decrypted chat, structured tool evidence, and escalation context", async () => {
    state.history = [
      {
        id: "chat-user",
        role: "operator",
        content: `${pii.email} ${pii.ssn} ${pii.dob} ${pii.address}`,
        tool_calls: null,
        tool_call_id: null,
      },
      {
        id: "chat-agent",
        role: "agent",
        content: "",
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: {
            name: "screening_lookup",
            arguments: JSON.stringify({
              full_name: pii.name,
              contact_email: pii.email,
              check_id: "9ccb49a8-922d-4256-bd6a-8d311159c80f",
            }),
          },
        }],
        tool_call_id: null,
      },
      {
        id: "chat-tool",
        role: "tool",
        content: JSON.stringify({
          hit_file: {
            vendorPayload: {
              candidates: [{ name: pii.name, dob: pii.dob, address: pii.address }],
            },
          },
        }),
        tool_calls: null,
        tool_call_id: "call-1",
      },
    ];
    createMock.mockResolvedValue(finalResponse());

    await runOperatorLoop({
      threadId: "thread-1",
      actor: "0xoperator",
      sessionId: "session-1",
      turnId: "turn-1",
      escalationId: "escalation-1",
      mode: "human",
      escalationContext: `${pii.email} ${pii.ssn} ${pii.dob} ${pii.address}`,
    });

    const request = createMock.mock.calls[0]![0] as { messages: unknown[] };
    const modelPayload = JSON.stringify(request.messages);
    for (const value of Object.values(pii)) expect(modelPayload).not.toContain(value);
    expect(modelPayload).toContain("<redacted:");
    // Operational identifiers (check ids, intent ids) must survive replay —
    // the model repeats them to consume a browser-approved confirmation.
    expect(modelPayload).toContain("9ccb49a8-922d-4256-bd6a-8d311159c80f");
  });

  it("redacts fresh tool arguments/results before the next model round while retaining originals", async () => {
    state.tools = [{
      definition: {
        type: "function",
        function: { name: "screening_lookup", description: "test", parameters: {} },
      },
      execute: vi.fn(async () => JSON.stringify({
        candidates: [{ name: pii.name, full_name: pii.name, email: pii.email }],
        ssn: pii.ssn,
        dob: pii.dob,
        address: pii.address,
      })),
    }];
    createMock
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: `Looking up ${pii.ssn}`,
            tool_calls: [{
              id: "call-live",
              type: "function",
              function: {
                name: "screening_lookup",
                arguments: JSON.stringify({
                  full_name: pii.name,
                  email: pii.email,
                  address: pii.address,
                }),
              },
            }],
          },
        }],
      })
      .mockResolvedValueOnce(finalResponse());

    await runOperatorLoop({
      threadId: "thread-1",
      actor: "0xoperator",
      sessionId: "session-1",
      turnId: "turn-1",
      escalationId: null,
      mode: "free_form",
    });

    const secondRequest = createMock.mock.calls[1]![0] as { messages: unknown[] };
    const modelPayload = JSON.stringify(secondRequest.messages);
    for (const value of Object.values(pii)) expect(modelPayload).not.toContain(value);
    expect(modelPayload).toContain("<redacted:");

    const persisted = JSON.stringify(state.appended);
    expect(persisted).toContain(pii.name);
    expect(persisted).toContain(pii.email);
    expect(persisted).toContain(pii.ssn);
  });
});

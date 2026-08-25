import type { PreExecuteAgentConfig } from "../../core/serviceRegistry/types.js";

// Pre-execute LLM review, per skill. Disabled here so the dummy runs
// without an LLM key; the shape is what matters. When enabled, core's
// preExecuteRunner calls the model before executeAdapter and routes on
// proceed | reject | escalate. Operators can override every field (and
// the prompt) from the admin UI's per-service LLM config editor. For
// irreversible, money-losing skills prefer `onError: "escalate"` (fail
// closed to human review on LLM outage).
export const preExecuteAgent: Record<string, PreExecuteAgentConfig> = {
  "create-note": {
    systemPrompt:
      "You review note-creation requests for a demonstration service. " +
      "Reject notes whose title or body contains credentials, secrets, or " +
      "personal data that a buyer agent should not be storing here.",
    escalationRules:
      "Escalate when the note content looks like an attempt to use this " +
      "demo service as a dead-drop (encoded payloads, key material).",
    model: "gpt-5.4-mini",
    enabled: false,
    timeoutMs: 10_000,
    onError: "proceed",
  },
};

import { describe, it, expect } from "vitest";
import {
  maxTokensParam,
  usesCompletionTokensParam,
} from "../src/core/llm/params.js";

// The gpt-5.x / o-series families use max_completion_tokens; the older
// gpt-4.x / gpt-3.5 chat models use max_tokens. The agents let ops pin a
// different model per env, so the param choice is derived from the model
// string at call time.

describe("usesCompletionTokensParam", () => {
  it("selects max_completion_tokens for the gpt-5.x family", () => {
    for (const m of ["gpt-5.4-mini", "gpt-5", "GPT-5.4-MINI", "gpt-5o"]) {
      expect(usesCompletionTokensParam(m), m).toBe(true);
    }
  });

  it("selects max_completion_tokens for the o-series", () => {
    for (const m of ["o1", "o1-mini", "o3", "o3-mini", "o4-mini"]) {
      expect(usesCompletionTokensParam(m), m).toBe(true);
    }
  });

  it("keeps max_tokens for older chat models", () => {
    for (const m of ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"]) {
      expect(usesCompletionTokensParam(m), m).toBe(false);
    }
  });

  it("does not false-positive on names that merely start with 'o'", () => {
    expect(usesCompletionTokensParam("olmo-7b")).toBe(false);
  });
});

describe("maxTokensParam", () => {
  it("returns the completion-tokens key for gpt-5.4-mini", () => {
    expect(maxTokensParam("gpt-5.4-mini", 800)).toEqual({
      max_completion_tokens: 800,
    });
  });

  it("returns the legacy key for gpt-4o-mini", () => {
    expect(maxTokensParam("gpt-4o-mini", 500)).toEqual({ max_tokens: 500 });
  });
});

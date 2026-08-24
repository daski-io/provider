import { describe, it, expect } from "vitest";
import {
  parseDecision,
  onErrorDecision,
} from "../src/core/engine/preExecuteRunner.js";

// Pure-function coverage for the pre-execute decision logic:
//   - parseDecision maps the model's JSON to a decision, or null when it
//     can't (malformed / unrecognized) so the caller applies the fail mode;
//   - onErrorDecision turns "can't decide" into proceed (fail-open) or
//     escalate (fail-closed) per the skill's configured onError.

describe("parseDecision", () => {
  it("parses a proceed decision", () => {
    expect(parseDecision('{"decision":"proceed"}')).toEqual({ action: "proceed" });
  });

  it("parses a reject decision with its reason", () => {
    expect(parseDecision('{"decision":"reject","reason":"profanity"}')).toEqual({
      action: "reject",
      reason: "profanity",
    });
  });

  it("parses an escalate decision with its reviewQuestion", () => {
    expect(
      parseDecision('{"decision":"escalate","reviewQuestion":"brand-adjacent?"}'),
    ).toEqual({ action: "escalate", reviewQuestion: "brand-adjacent?" });
  });

  it("is case-insensitive on the action", () => {
    expect(parseDecision('{"decision":"PROCEED"}')).toEqual({ action: "proceed" });
  });

  it("returns null on malformed JSON (caller applies the fail mode)", () => {
    expect(parseDecision("not json at all")).toBeNull();
  });

  it("returns null on an unrecognized action", () => {
    expect(parseDecision('{"decision":"frobnicate"}')).toBeNull();
  });

  it("returns null when the decision field is missing", () => {
    expect(parseDecision('{"reason":"x"}')).toBeNull();
  });
});

describe("onErrorDecision (fail mode)", () => {
  it("proceeds when the skill is configured fail-open", () => {
    expect(onErrorDecision({ onError: "proceed" } as never)).toEqual({
      action: "proceed",
    });
  });

  it("escalates when the skill is configured fail-closed", () => {
    const d = onErrorDecision({ onError: "escalate" } as never);
    expect(d.action).toBe("escalate");
    if (d.action === "escalate") expect(d.reviewQuestion).toMatch(/review/i);
  });
});

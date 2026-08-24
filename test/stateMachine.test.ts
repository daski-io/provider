import { describe, it, expect } from "vitest";
import {
  canTransition,
  validateTransition,
  isTerminalState,
  TransitionError,
} from "../src/core/engine/stateMachine.js";

// Regression coverage for the 2026-07-04 incident: pre-execute rejection
// calls failTransactionWithRefund on a task that is still `submitted`.
// Before the fix, submitted -> failed was not a legal edge, so the
// rejection path itself threw TransitionError, the buyer saw -32603, and
// the row stayed stranded in `submitted`.

describe("state machine", () => {
  it("allows submitted -> failed (pre-flight rejection terminates cleanly)", () => {
    expect(canTransition("submitted", "failed")).toBe(true);
    expect(() => validateTransition("submitted", "failed")).not.toThrow();
  });

  it("keeps the ordinary lifecycle edges", () => {
    expect(canTransition("submitted", "working")).toBe(true);
    expect(canTransition("submitted", "canceled")).toBe(true);
    expect(canTransition("working", "completed")).toBe(true);
    expect(canTransition("working", "failed")).toBe(true);
    expect(canTransition("working", "input-required")).toBe(true);
    expect(canTransition("input-required", "working")).toBe(true);
  });

  it("still refuses to skip straight to completed from submitted", () => {
    expect(canTransition("submitted", "completed")).toBe(false);
    expect(() => validateTransition("submitted", "completed")).toThrow(TransitionError);
  });

  it("terminal states stay terminal (except the admin failed -> working recovery)", () => {
    expect(isTerminalState("failed")).toBe(true);
    expect(canTransition("completed", "failed")).toBe(false);
    expect(canTransition("canceled", "working")).toBe(false);
    expect(canTransition("failed", "working")).toBe(true); // admin recovery
    expect(canTransition("failed", "completed")).toBe(false);
  });
});

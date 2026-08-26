import { describe, expect, it } from "vitest";
import { parseMessage } from "../validation.js";

describe("dummy input validation", () => {
  it("counts Unicode code points", () => {
    expect(parseMessage("🙂".repeat(500))).toHaveLength(1_000);
    expect(() => parseMessage("🙂".repeat(501))).toThrow(/500/);
  });

  it("rejects missing, blank, and non-string input", () => {
    for (const value of [undefined, null, 42, "   "]) {
      expect(() => parseMessage(value)).toThrow();
    }
  });
});

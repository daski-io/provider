import { describe, expect, it } from "vitest";
import {
  extractDataFromParts,
  extractTextFromParts,
  normalizeMethod,
} from "../src/core/a2a/parts.js";

describe("A2A v1 input normalization", () => {
  it("accepts only canonical PascalCase method names", () => {
    expect(normalizeMethod("SendMessage")).toBe("SendMessage");
    expect(normalizeMethod("GetTask")).toBe("GetTask");
    expect(normalizeMethod("message/send")).toBeUndefined();
    expect(normalizeMethod("tasks/get")).toBeUndefined();
  });

  it("reads only the v1 kind discriminator", () => {
    const message = {
      parts: [
        { type: "text", text: "obsolete" },
        { kind: "text", text: "current" },
        { type: "data", data: { ignored: true } },
        { kind: "data", data: { accepted: true } },
      ],
    };

    expect(extractTextFromParts(message)).toBe("current");
    expect(extractDataFromParts(message)).toEqual({ accepted: true });
  });
});

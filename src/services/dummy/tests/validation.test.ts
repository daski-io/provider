import { describe, expect, it } from "vitest";
import {
  BODY_MAX,
  MESSAGE_MAX,
  TITLE_MAX,
  countCharacters,
  validateBody,
  validateMessage,
  validateTitle,
} from "../validation.js";

describe("dummy input boundaries", () => {
  it("accepts limits and rejects the first value beyond them", () => {
    expect(validateTitle("a".repeat(TITLE_MAX))).toMatchObject({ ok: true });
    expect(validateTitle("a".repeat(TITLE_MAX + 1))).toMatchObject({
      ok: false,
      error: { field: "title", code: "too_long" },
    });
    expect(validateBody("b".repeat(BODY_MAX))).toBeNull();
    expect(validateBody("b".repeat(BODY_MAX + 1))).toMatchObject({
      field: "body",
      code: "too_long",
    });
    expect(validateMessage("m".repeat(MESSAGE_MAX))).toBeNull();
    expect(validateMessage("m".repeat(MESSAGE_MAX + 1))).toMatchObject({
      field: "message",
      code: "too_long",
    });
  });

  it("counts Unicode code points instead of UTF-16 code units", () => {
    expect(countCharacters("🙂")).toBe(1);
    expect(validateTitle(`${"🙂".repeat(TITLE_MAX - 1)}a`))
      .toMatchObject({ ok: true, identifier: "a" });
    expect(validateMessage("🙂".repeat(MESSAGE_MAX))).toBeNull();
    expect(validateMessage("🙂".repeat(MESSAGE_MAX + 1))).toMatchObject({
      field: "message",
      code: "too_long",
    });
  });
});

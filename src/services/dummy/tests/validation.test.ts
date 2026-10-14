import { describe, expect, it } from "vitest";
import { dummyService } from "../index.js";
import { messageFieldErrors, parseMessage } from "../validation.js";

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

  it("declines before payment a message the echo could not deliver", async () => {
    const readiness = (message: string) => dummyService.requestReadiness!({
      skillId: "echo",
      input: { message },
      payer: null,
      signal: new AbortController().signal,
    });
    await expect(readiness("hello")).resolves.toEqual({ ready: true });
    await expect(readiness("   ")).resolves.toMatchObject({
      ready: false, fieldErrors: [{ path: "message", rule: "min-length" }],
    });
    for (const active of ["online=1", "Fill the <form>", "javascript:alert(1)", "tab\u000bbed"]) {
      await expect(readiness(active)).resolves.toMatchObject({
        ready: false, fieldErrors: [{ path: "message", rule: "passive-text" }],
      });
    }
    // Field errors never echo the submitted value.
    expect(JSON.stringify(messageFieldErrors({ message: "online=secret" }))).not.toContain("secret");
  });
});

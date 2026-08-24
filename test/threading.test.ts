import { describe, it, expect } from "vitest";
import { computeThreadRoot } from "../src/core/email/threading.js";

// Pure unit tests for thread_root derivation. The root is the earliest
// Message-ID we can derive: References[0], else In-Reply-To, else the
// email's own Message-ID.

describe("computeThreadRoot", () => {
  it("uses the first References entry when present", () => {
    expect(
      computeThreadRoot({
        messageId: "<self@host>",
        inReplyTo: "<parent@host>",
        references: ["<root@host>", "<parent@host>"],
      }),
    ).toBe("<root@host>");
  });

  it("falls back to In-Reply-To when there are no References", () => {
    expect(
      computeThreadRoot({
        messageId: "<self@host>",
        inReplyTo: "<parent@host>",
        references: [],
      }),
    ).toBe("<parent@host>");
  });

  it("falls back to its own Message-ID when it starts a thread", () => {
    expect(
      computeThreadRoot({
        messageId: "<self@host>",
        inReplyTo: null,
        references: [],
      }),
    ).toBe("<self@host>");
  });
});

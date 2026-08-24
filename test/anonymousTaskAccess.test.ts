import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_TASK_ACCESS_ARTIFACT,
  ANONYMOUS_TASK_ACCESS_HASH_KEY,
  appendAnonymousTaskAccess,
  issueAnonymousTaskAccess,
  verifyAnonymousTaskAccess,
} from "../src/core/a2a/anonymousTaskAccess.js";

describe("anonymous task access", () => {
  it("accepts only the issued token", () => {
    const access = issueAnonymousTaskAccess("task-1");
    const metadata = { [ANONYMOUS_TASK_ACCESS_HASH_KEY]: access.hash };

    expect(verifyAnonymousTaskAccess(access.token, metadata)).toBe(true);
    expect(verifyAnonymousTaskAccess("x".repeat(43), metadata)).toBe(false);
    expect(verifyAnonymousTaskAccess(undefined, metadata)).toBe(false);
  });

  it("returns the token as a synthetic submission artifact", () => {
    const access = issueAnonymousTaskAccess("task-anonymous");
    const response = appendAnonymousTaskAccess({
      id: "task-anonymous",
      status: {
        state: "TASK_STATE_COMPLETED",
        message: { role: "ROLE_AGENT", parts: [] },
      },
    }, access.token);

    const artifact = response.artifacts?.at(-1);
    expect(artifact?.name).toBe(ANONYMOUS_TASK_ACCESS_ARTIFACT);
    expect(artifact?.parts[0]?.data?.taskAccessToken).toBe(access.token);
  });

  it("is stable only for the same task id", () => {
    expect(issueAnonymousTaskAccess("task-1")).toEqual(
      issueAnonymousTaskAccess("task-1"),
    );
    expect(issueAnonymousTaskAccess("task-2").token).not.toBe(
      issueAnonymousTaskAccess("task-1").token,
    );
  });
});

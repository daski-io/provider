import { describe, expect, it } from "vitest";
import type { TaskContext } from "../../../core/serviceRegistry/types.js";
import { DummyAdapter } from "../adapter.js";
import { NOTE_PRICE_ATOMIC } from "../config.js";
import { dummyService } from "../index.js";
import { skills } from "../manifest.js";

const adapter = new DummyAdapter();

function task(skillId: string): TaskContext {
  return {
    id: "task-dummy-1",
    service_id: "service-dummy-1",
    skill_id: skillId,
    status: "working",
  };
}

describe("dummy service", () => {
  it("ships complete docs for every declared skill", () => {
    expect(dummyService.manifest.slug).toBe("dummy");
    expect(Object.keys(dummyService.protocol.docs.skills).sort())
      .toEqual(skills.map((skill) => skill.id).sort());
    expect(dummyService.protocol.docs.service).not.toContain(
      "Documentation unavailable",
    );
    for (const doc of Object.values(dummyService.protocol.docs.skills)) {
      expect(doc).not.toContain("Documentation unavailable");
    }
  });

  it("quotes and executes the free echo skill", async () => {
    await expect(adapter.quote("echo", { message: "hello daski" })).resolves.toEqual({
      ok: true,
      amount: 0n,
      currency: "USDC",
    });

    const result = await adapter.execute(
      "echo",
      task("echo"),
      { message: "hello daski" },
    );
    expect(result).toMatchObject({
      status: "completed",
      message: "Echo completed.",
      artifacts: [{
        name: "echo_result",
        data: {
          message: "hello daski",
          processedAt: expect.any(String),
        },
      }],
    });
    expect(result.asset).toBeUndefined();
  });

  it("quotes, executes, and identifies the paid note asset", async () => {
    const quote = await adapter.quote("create-note", {
      title: "Launch Checklist!",
      body: "hello world",
    });
    expect(quote).toMatchObject({
      ok: true,
      amount: BigInt(NOTE_PRICE_ATOMIC),
      currency: "USDC",
    });

    const result = await adapter.execute(
      "create-note",
      task("create-note"),
      { title: "Launch Checklist!", body: "hello world" },
    );
    expect(result).toMatchObject({
      status: "completed",
      artifacts: [{
        name: "note_created",
        data: {
          note: "launch-checklist",
          title: "Launch Checklist!",
          characters: 11,
        },
      }],
      asset: {
        assetType: "note",
        assetIdentifier: "launch-checklist",
        assetData: {
          title: "Launch Checklist!",
          characters: 11,
        },
      },
    });
    expect(await dummyService.assets?.assetIdentifierFromData?.(
      "create-note",
      { title: "Launch Checklist!" },
    )).toBe("launch-checklist");
    expect(await dummyService.assets?.assetIdentifierFromData?.(
      "echo",
      { title: "Launch Checklist!" },
    )).toBeNull();
  });

  it("rejects invalid and unknown requests without side effects", async () => {
    await expect(adapter.quote("echo", { message: " " })).resolves.toMatchObject({
      ok: false,
      errors: [{ field: "message", code: "missing" }],
    });
    await expect(adapter.execute(
      "create-note",
      task("create-note"),
      { title: "!!!" },
    )).resolves.toMatchObject({
      status: "failed",
      error: "title must contain at least one letter or digit",
    });
    await expect(adapter.execute("unknown", task("unknown"), {}))
      .rejects.toThrow("Unknown skill: unknown");
  });
});

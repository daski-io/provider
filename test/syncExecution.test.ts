import { afterEach, describe, expect, it, vi } from "vitest";
import type { FulfillmentAdapter, ServiceResult } from "../src/core/serviceRegistry/types.js";
import { compileProviderSchema } from "../src/core/standardRail/schema.js";
import {
  SERVICE_EXECUTION_FAILED,
  SERVICE_RESULT_INVALID,
  terminalServiceResult,
  type ResultContract,
} from "../src/core/standardRail/serviceResult.js";
import { executeSynchronously, MAX_EXECUTION_MS } from "../src/core/standardRail/syncExecution.js";
import { echoResultSchema } from "./standardRailOutcomeFixture.js";

const contract: ResultContract = {
  validate: compileProviderSchema(echoResultSchema()),
  failureCodes: new Set(["invalid_input"]),
};
const context = {
  taskId: "task-1",
  orderId: "ord_00000000-0000-4000-8000-000000000001",
  payer: "0x1111111111111111111111111111111111111111" as const,
  serviceSlug: "dummy",
  skillId: "echo",
};
const adapter = (execute: FulfillmentAdapter["execute"]): FulfillmentAdapter => ({ execute });
const returning = (value: unknown) => adapter(async () => value as ServiceResult);
const completed = {
  status: "completed" as const,
  message: "Echo completed.",
  artifacts: [{ name: "echo_result", mimeType: "application/json", data: { message: "hi" } }],
};

function capturedErrors(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("synchronous terminal results", () => {
  it("freezes the complete completed result in its stored JSON form", async () => {
    const result = await executeSynchronously(
      returning({ ...completed, extra: undefined }),
      context,
      { message: "hi" },
      contract,
    );
    expect(result).toEqual(completed);
    expect(Object.keys(result)).not.toContain("extra");
  });

  it("turns a result outside the admitted schema into a reviewed failure with a stable diagnostic", async () => {
    const log = capturedErrors();
    for (const value of [
      { ...completed, processedAt: "2026-10-14T00:00:00Z" },
      { ...completed, artifacts: [{ name: "echo_result", data: { secret: "do-not-log" } }] },
      { ...completed, message: "m".repeat(501) },
    ]) {
      await expect(executeSynchronously(returning(value), context, {}, contract))
        .resolves.toEqual({ status: "failed", errorCode: SERVICE_RESULT_INVALID });
    }
    log.restore();
    const entries = log.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        level: "error",
        message: "Synchronous result failed its admitted result contract",
        diagnostic: "result_schema_mismatch",
        serviceSlug: "dummy",
        skillId: "echo",
      });
    }
    expect(log.lines.join("")).not.toContain("do-not-log");
    expect(log.lines.join("")).not.toContain("processedAt");
  });

  it("refuses unstorable, oversized or unsafe completed results", () => {
    for (const [value, code] of [
      [{ status: "completed", message: "bad\u0000byte" }, "result_unstorable"],
      [{ status: "completed", message: "\ud800" }, "result_unstorable"],
      [{ status: "completed", artifacts: [{ name: "x", data: { message: "y".repeat(1_000_001) } }] },
        "result_out_of_bounds"],
      [{ status: "completed", artifacts: [{ name: "Bad Name" }] }, "result_artifact_invalid"],
      [{ status: "completed", artifacts: [{ name: "x", url: "http://example.test/r" }] },
        "result_artifact_invalid"],
      [{ status: "completed", artifacts: [{ name: "x", url: "https://user:pw@example.test/r" }] },
        "result_artifact_invalid"],
    ] as const) {
      const terminal = terminalServiceResult(value, contract);
      expect(terminal.result).toEqual({ status: "failed", errorCode: SERVICE_RESULT_INVALID });
      expect(terminal.diagnostic?.code).toBe(code);
    }
  });

  it("attests failures as a reviewed code without free text", () => {
    const failure = (errorCode: unknown, message = "Secret upstream detail 0xdeadbeef") =>
      terminalServiceResult({ status: "failed", errorCode, message }, contract).result;
    expect(failure("invalid_input")).toEqual({ status: "failed", errorCode: "invalid_input" });
    expect(failure(SERVICE_RESULT_INVALID)).toEqual({ status: "failed", errorCode: SERVICE_RESULT_INVALID });
    for (const unreviewed of ["user_42_not_found", "Invalid_Input", "x", 7, undefined]) {
      expect(failure(unreviewed)).toEqual({ status: "failed", errorCode: SERVICE_EXECUTION_FAILED });
    }
  });

  it("maps throws, timeouts and non-terminal answers to the generic failure", async () => {
    const generic = { status: "failed", errorCode: SERVICE_EXECUTION_FAILED };
    await expect(executeSynchronously(adapter(async () => {
      throw new Error("upstream said: account 1234 is locked");
    }), context, {}, contract)).resolves.toEqual(generic);
    for (const value of [null, "done", [], { status: "working" }, { status: "executing" }]) {
      await expect(executeSynchronously(returning(value), context, {}, contract)).resolves.toEqual(generic);
    }
    vi.useFakeTimers();
    const pending = executeSynchronously(adapter(() => new Promise(() => undefined)), context, {}, contract);
    await vi.advanceTimersByTimeAsync(MAX_EXECUTION_MS);
    await expect(pending).resolves.toEqual(generic);
  });
});

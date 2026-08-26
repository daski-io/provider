import { describe, expect, it } from "vitest";
import { DummyAdapter } from "../adapter.js";
import { assertDummyServiceAllowed } from "../config.js";
import { dummyService } from "../index.js";

const context = {
  taskId: "task-1",
  orderId: "ord_00000000-0000-4000-8000-000000000000",
  payer: "0x1111111111111111111111111111111111111111" as const,
  serviceSlug: "dummy",
  skillId: "echo",
  signal: new AbortController().signal,
};

describe("dummy service", () => {
  it("is one fixed-price synchronous skill with complete docs", () => {
    expect(dummyService.skills).toHaveLength(1);
    expect(dummyService.skills[0]).toMatchObject({
      id: "echo",
      fixedPriceAtomic: "10000",
    });
    expect(dummyService.docs.service).toContain("smallest complete");
    expect(dummyService.docs.skills.echo).toContain("synchronous");
  });

  it("returns a terminal echo artifact", async () => {
    await expect(new DummyAdapter().execute(context, { message: "hello" })).resolves.toEqual({
      status: "completed",
      message: "Echo completed.",
      artifacts: [{
        name: "echo_result",
        mimeType: "application/json",
        data: { message: "hello" },
      }],
    });
  });

  it("fails closed for invalid input and Base mainnet", async () => {
    await expect(new DummyAdapter().execute(context, { message: "" })).resolves.toMatchObject({
      status: "failed",
      errorCode: "invalid_input",
    });
    expect(() => assertDummyServiceAllowed(8453)).toThrow(/replace/);
    expect(() => assertDummyServiceAllowed(84532)).not.toThrow();
  });
});

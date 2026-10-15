import { describe, expect, it } from "vitest";
import {
  PUBLISHED_SKILL_CONTRACT_KEYS,
  publishedSkillContract,
} from "../../../core/agentCards/contractExtension.js";
import type { FulfillmentAdapter } from "../../../core/serviceRegistry/types.js";
import { compileProviderSchema, validateProviderRequest } from "../../../core/standardRail/schema.js";
import { terminalServiceResult } from "../../../core/standardRail/serviceResult.js";
import { DummyAdapter } from "../adapter.js";
import { dummyService } from "../index.js";

/**
 * The published echo contract. Changing it changes the skill contract hash,
 * which needs a newly issued runtime bundle for every listing that serves it.
 * Previous issued value: 0xdf0ac577831ca36ab3b2e0cd9700ee8428f7eae2a6b184f62eb5d6032f7a7a1f.
 */
const ECHO_SKILL_CONTRACT_HASH = "0x4efd0a112e2fae4402d41c9ed1e10dfb10ac63d3e5251622e5ed6cc803317f17";

const context = (skillId = "echo") => ({
  taskId: "task-1",
  orderId: "ord_00000000-0000-4000-8000-000000000000",
  payer: "0x1111111111111111111111111111111111111111" as const,
  serviceSlug: "dummy",
  skillId,
  supplierCostCeiling: null,
  signal: new AbortController().signal,
});

const echo = publishedSkillContract(dummyService, dummyService.skills[0]!, "https://provider.test");

describe("dummy echo skill contract", () => {
  it("publishes the gateway's closed contract key set without payer-DNS gating", () => {
    expect(Object.keys(echo.contract).sort()).toEqual([...PUBLISHED_SKILL_CONTRACT_KEYS].sort());
    expect(echo.contract).toMatchObject({
      purchaseReadiness: null,
      fulfillmentMode: "automated",
      deadlines: { dispatchSeconds: 300, fulfillmentSeconds: 900 },
    });
    expect(echo.skillContractHash).toBe(ECHO_SKILL_CONTRACT_HASH);
  });

  it("describes exactly the complete result the adapter returns", async () => {
    // L-T01: an existing synchronous adapter class still satisfies the interface.
    const adapter: FulfillmentAdapter = new DummyAdapter();
    const validate = compileProviderSchema(echo.contract.resultSchema as Record<string, unknown>);
    for (const message of ["hello", "x".repeat(500), "🙂".repeat(500), "  padded  "]) {
      const result = await adapter.execute(context(), { message });
      expect(result.status).toBe("completed");
      expect(() => validateProviderRequest(validate, result, "Response")).not.toThrow();
    }
    const completed = await adapter.execute(context(), { message: "hello" });
    for (const reshaped of [
      { ...completed, processedAt: "2026-10-14T00:00:00Z" },
      { status: "completed", message: "Echo completed." },
      { ...completed, status: "failed" },
      (completed.status === "completed" && completed.artifacts)
        ? { ...completed, artifacts: [{ ...completed.artifacts[0], data: {} }] }
        : null,
    ]) {
      expect(() => validateProviderRequest(validate, reshaped, "Response")).toThrow();
    }
  });

  it("returns only reviewed failure codes, attested without the adapter message", async () => {
    const adapter = new DummyAdapter();
    const contract = {
      validate: compileProviderSchema(echo.contract.resultSchema as Record<string, unknown>),
      failureCodes: new Set(dummyService.failureCodes),
    };
    for (const [skillId, input, errorCode] of [
      ["echo", { message: "   " }, "invalid_input"],
      ["other", { message: "hi" }, "unknown_skill"],
    ] as const) {
      const failed = await adapter.execute(context(skillId), input);
      expect(failed).toMatchObject({ status: "failed", errorCode });
      expect(terminalServiceResult(failed, contract).result).toEqual({ status: "failed", errorCode });
    }
  });
});

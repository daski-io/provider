import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "../src/core/db/queryable.js";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  recordMandatoryAudit: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    connect: mocks.connect,
    query: vi.fn(),
  },
}));
vi.mock("../src/core/events/emitter.js", () => ({
  recordMandatoryAudit: mocks.recordMandatoryAudit,
}));

import { commitAdminAssetMutation } from "../src/core/admin/assetMutation.js";
import {
  createServiceRule,
  deactivateServiceRule,
} from "../src/core/db/queries/serviceRules.js";
import { updateServiceSkillPricing } from "../src/core/db/queries/skills.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({
    query: mocks.query,
    release: mocks.release,
  });
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    return { rows: [{ id: "row-1" }] };
  });
  mocks.recordMandatoryAudit.mockResolvedValue(undefined);
});

describe("transactional admin audit commands", () => {
  it("creates a service rule and its audit on the same client", async () => {
    const row = {
      id: "rule-1",
      service_id: "service-1",
      skill_id: null,
      scope: "all",
      rule: "Escalate.",
      created_by: "0xoperator",
      created_at: new Date(),
      active: true,
    };
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO service_rules")) return { rows: [row] };
      return { rows: [] };
    });

    await expect(createServiceRule({
      service_id: row.service_id,
      rule: row.rule,
      created_by: row.created_by,
    })).resolves.toBe(row);

    expect(mocks.recordMandatoryAudit).toHaveBeenCalledWith(
      expect.objectContaining({ query: mocks.query }),
      expect.objectContaining({
        serviceId: row.service_id,
        actor: row.created_by,
        type: "admin.service_rule.created",
      }),
    );
    expect(mocks.query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("records the deactivating actor inside the rule transaction", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE service_rules")) {
        return {
          rows: [{
            id: "rule-1",
            service_id: "service-1",
            skill_id: null,
            scope: "all",
          }],
        };
      }
      return { rows: [] };
    });

    await deactivateServiceRule("rule-1", "0xoperator");

    expect(mocks.recordMandatoryAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: "0xoperator",
        type: "admin.service_rule.deactivated",
      }),
    );
  });

  it("rolls back all skill prices when the mandatory audit fails", async () => {
    mocks.recordMandatoryAudit.mockRejectedValueOnce(
      new Error("audit unavailable"),
    );

    await expect(updateServiceSkillPricing({
      serviceId: "service-1",
      actor: "0xoperator",
      fixedAmountAtomic: 9_990_000n,
      updates: [{
        id: "skill-row-1",
        skillId: "paid-skill",
        pricing: {
          USDC: { type: "one-time", fixed_amount: "9990000" },
        },
      }],
    })).rejects.toThrow("audit unavailable");

    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(mocks.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("runs service-owned state changes and the audit on the asset transaction", async () => {
    const additionalMutation = vi.fn(async (db: Queryable) => {
      expect(db.query).toBe(mocks.query);
      await db.query(
        "UPDATE service_asset_state SET active = false WHERE asset_id = $1",
        ["asset-1"],
      );
    });

    await commitAdminAssetMutation({
      assetId: "asset-1",
      serviceId: "service-1",
      actor: "0xoperator",
      expectedStatus: "active",
      status: "suspended",
      additionalMutation,
      event: {
        type: "item.suspended",
        message: "Item suspended.",
      },
    });

    expect(additionalMutation).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledWith(
      "UPDATE service_asset_state SET active = false WHERE asset_id = $1",
      ["asset-1"],
    );
    expect(mocks.recordMandatoryAudit).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("rolls back the asset mutation when service-owned state fails", async () => {
    const additionalMutation = vi.fn().mockRejectedValueOnce(
      new Error("service state unavailable"),
    );

    await expect(commitAdminAssetMutation({
      assetId: "asset-1",
      serviceId: "service-1",
      actor: "0xoperator",
      expectedStatus: "active",
      status: "suspended",
      additionalMutation,
      event: {
        type: "item.suspended",
        message: "Item suspended.",
      },
    })).rejects.toThrow("service state unavailable");

    expect(additionalMutation).toHaveBeenCalledOnce();
    expect(mocks.recordMandatoryAudit).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(mocks.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("rolls back an asset mutation when its audit cannot be stored", async () => {
    mocks.recordMandatoryAudit.mockRejectedValueOnce(
      new Error("audit unavailable"),
    );

    await expect(commitAdminAssetMutation({
      assetId: "asset-1",
      serviceId: "service-1",
      actor: "0xoperator",
      expectedStatus: "active",
      status: "suspended",
      event: {
        type: "item.suspended",
        message: "Item suspended.",
      },
    })).rejects.toThrow("audit unavailable");

    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK");
  });
});

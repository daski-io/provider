import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  audit: vi.fn(),
  persistedConfig: null as Record<string, unknown> | null,
  existingConfig: {} as Record<string, unknown>,
  upsertSql: "",
}));

vi.mock("../src/core/db/pool.js", () => ({ pool: {} }));
vi.mock("../src/core/db/queryable.js", () => ({
  inTransaction: vi.fn(async (_pool: unknown, work: (db: unknown) => Promise<unknown>) =>
    work({ query: h.query })),
}));
vi.mock("../src/core/chain/encryption.js", () => ({
  decryptString: vi.fn((value: string) => value),
  encryptString: vi.fn((value: string) => value),
}));
vi.mock("../src/core/events/emitter.js", () => ({ recordMandatoryAudit: h.audit }));

import { setSupplierConfig } from "../src/core/suppliers/credentials.js";

const existing = {
  supplier: "sample-supplier",
  credentials_encrypted: "{}",
  sandbox: false,
  notes: null,
  config: {},
  updated_by: "operator",
  updated_at: new Date("2026-07-15T00:00:00Z"),
  config_revision: "7",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.persistedConfig = null;
  h.existingConfig = { margin_bps: -9000, callback_id: "old-callback" };
  h.upsertSql = "";
  h.query.mockImplementation(async (sql: string, args: unknown[] = []) => {
    if (sql.includes("FROM supplier_configs") && sql.includes("FOR UPDATE")) {
      return { rows: [{ ...existing, config: h.existingConfig }] };
    }
    if (sql.includes("INSERT INTO supplier_configs")) {
      h.upsertSql = sql;
      h.persistedConfig = args[4] as Record<string, unknown>;
      return {
        rows: [{
          ...existing,
          config: h.persistedConfig,
          updated_by: args[5],
          config_revision: "8",
        }],
      };
    }
    return { rows: [], rowCount: 1 };
  });

});

describe("supplier config patches", () => {
  it("merges against the row locked inside the transaction", async () => {
    const row = await setSupplierConfig(
      "sample-supplier",
      { configPatch: { callback_id: "new-callback" } },
      "system:callback-register",
    );

    expect(row.config).toEqual({ margin_bps: -9000, callback_id: "new-callback" });
    expect(h.persistedConfig).toEqual(row.config);
    expect(h.upsertSql).toContain("supplier_configs.config || EXCLUDED.config");
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ payload: expect.objectContaining({ changedFields: ["config"] }) }),
    );
  });

  it("rejects operator changes to immutable policy keys", async () => {
    h.existingConfig = {
      source_ids: ["approved"],
      locked_config_keys: ["source_ids", "locked_config_keys"],
    };
    await expect(setSupplierConfig(
      "screening",
      { configPatch: { source_ids: ["wider-scope"] } },
      "operator:wallet",
    )).rejects.toThrow("immutable policy version");
  });

  it("allows the system policy migration to update locked keys", async () => {
    h.existingConfig = {
      source_ids: ["old"],
      locked_config_keys: ["source_ids", "locked_config_keys"],
    };
    const row = await setSupplierConfig(
      "screening",
      { configPatch: { source_ids: ["approved"] } },
      "system:screening-policy-migration",
    );
    expect(row.config.source_ids).toEqual(["approved"]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  db: { query: vi.fn() } as { query: ReturnType<typeof vi.fn> },
}));

vi.mock("../src/core/db/pool.js", () => ({ pool: {} }));
vi.mock("../src/core/db/queryable.js", () => ({
  inTransaction: vi.fn(async (_pool, work) => work(h.db)),
}));
vi.mock("../src/core/events/emitter.js", () => ({ recordMandatoryAudit: vi.fn() }));
vi.mock("../src/core/security/escalationProtection.js", () => ({
  protectEscalationText: vi.fn((_id, _field, value) => value ?? null),
  revealEscalationFields: vi.fn((row) => row),
}));

import { closeEscalation } from "../src/core/db/queries/escalations.js";

beforeEach(() => {
  vi.clearAllMocks();
  h.db.query = h.dbQuery;
});

describe("standard review close", () => {
  it("closes the review and thread without reading retired settlement tables", async () => {
    h.dbQuery
      .mockResolvedValueOnce({
        rows: [{ id: "esc-1", transaction_id: "task-1", source: "auto", status: "resolved" }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await expect(closeEscalation({
      id: "esc-1",
      status: "resolved",
      resolved_by: "operator",
    })).resolves.toMatchObject({ id: "esc-1", status: "resolved" });

    const sql = h.dbQuery.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sql).toContain("source NOT IN ('pre_execute','fulfillment_hold')");
    expect(sql).toContain("UPDATE chat_threads");
    expect(sql).not.toMatch(/settlement_(?:observations|dispositions)|provider_quotes|payments/);
    expect(h.dbQuery).toHaveBeenCalledTimes(2);
  });

  it("requires a persisted outbound email before recording a replied disposition", async () => {
    h.dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(closeEscalation({
      id: "esc-1",
      status: "resolved",
      resolved_by: "operator",
      requireOutboundReply: true,
    })).resolves.toBeNull();
    const updateSql = String(h.dbQuery.mock.calls[0]?.[0]);
    expect(updateSql).toContain("FROM emails_outbound");
    expect(h.dbQuery.mock.calls[0]?.[1]).toEqual([
      "esc-1", "resolved", null, "operator", true,
    ]);
    expect(h.dbQuery).toHaveBeenCalledTimes(1);
  });
});

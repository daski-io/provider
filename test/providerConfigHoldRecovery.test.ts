import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../src/core/db/queryable.js";

const h = vi.hoisted(() => ({
  enqueue: vi.fn(async () => ({ id: "job-1" })),
  audit: vi.fn(),
  open: vi.fn(),
  seal: vi.fn(() => ({
    editsEncrypted: null,
    editsHash: null,
    bindingEncrypted: "daski:v1:new-binding",
    bindingHash: "new-binding-hash",
  })),
}));

vi.mock("../src/core/db/pool.js", () => ({ pool: {} }));
vi.mock("../src/core/db/queries/durableJobs.js", () => ({
  enqueueDurableJob: h.enqueue,
}));
vi.mock("../src/core/events/emitter.js", () => ({
  recordMandatoryAudit: h.audit,
}));
vi.mock("../src/core/security/escalationProtection.js", () => ({
  protectEscalationText: vi.fn((_id, _field, value) => value),
  revealEscalationFields: vi.fn((row) => row),
}));
vi.mock("../src/core/engine/escalationSnapshot.js", () => ({
  openExecutionSnapshot: h.open,
  sealReviewEvidence: h.seal,
  buildExecutionSnapshot: vi.fn(),
  hashCanonical: vi.fn(),
  sealExecutionSnapshot: vi.fn(),
  validateAndMergeReviewerEdits: vi.fn(),
}));

import { queueProviderConfigHoldRetries } from
  "../src/core/engine/escalationResolutionStore.js";

describe("provider credential repair recovery", () => {
  it("queues every matching hold with fresh protected approval evidence", async () => {
    const row = {
      id: "hold-1",
      transaction_id: "task-1",
      source: "fulfillment_hold",
      status: "pending",
      snapshot_service_id: "service-1",
      snapshot_asset_id: null,
      execution_snapshot_hash: "snapshot-hash",
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT * FROM escalations")) return { rows: [row] };
      if (sql.includes("UPDATE escalations SET") && sql.includes("RETURNING *")) {
        return { rows: [{ ...row, status: "resolution_queued" }] };
      }
      return { rows: [] };
    });

    await expect(queueProviderConfigHoldRetries({
      supplier: "sample-supplier",
      actor: "admin:operator",
      db: { query: query as unknown as Queryable["query"] },
    })).resolves.toBe(1);

    expect(h.open).toHaveBeenCalledWith(row);
    expect(h.seal).toHaveBeenCalledWith(expect.objectContaining({
      binding: expect.objectContaining({ decision: "approved" }),
    }));
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      queue: "escalation-resolution",
      payload: { escalationId: "hold-1" },
      db: expect.anything(),
    }));
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: "fulfillment.hold.credentials_repaired",
    }));
  });
});

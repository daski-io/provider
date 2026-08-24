import { describe, expect, it, beforeEach, vi } from "vitest";

// Task finalization semantics (audit phase 1.4/1.5):
//   1. Deliverables (artifacts, asset) persist BEFORE the terminal status
//      write, inside one DB transaction — a consumer can never observe
//      `completed` while the deliverables are missing, and a failed
//      deliverable write leaves the task un-finalized.
//   2. Re-entrant results bridge through `working`: input-required →
//      completed/failed is legal via the core engine (services may
//      carry a private bridge for this).
//   3. Bus events fire only after the transaction
//      commits — nothing is announced that could still roll back.

const h = vi.hoisted(() => {
  const tx: { id: string; status: string; version: number; metadata: Record<string, unknown> } = {
    id: "task-1",
    status: "working",
    version: 1,
    metadata: {},
  };
  return {
    tx,
    query: vi.fn(async () => ({ rows: [] })),
    /** Interleaved log of deliverable writes and status writes. */
    order: [] as string[],
    auditFailOn: null as string | null,
    busEvents: [] as string[],
  };
});

vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: h.query,
    connect: vi.fn(async () => ({ query: h.query, release: vi.fn() })),
  },
}));

vi.mock("../src/core/db/queries/transactions.js", () => ({
  getTransactionById: vi.fn(async () => ({ ...h.tx })),
  setTransactionStatus: vi.fn(
    async (_id: string, status: string, opts: { expectedStatus?: string }) => {
      h.order.push(`status:${status}<-${opts.expectedStatus}`);
      h.tx.status = status;
      h.tx.version += 1;
      return { ...h.tx };
    },
  ),
  mergeTransactionMetadata: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
    Object.assign(h.tx.metadata, patch);
    return { ...h.tx };
  }),
  setTransactionAsset: vi.fn(async () => {
    h.order.push("asset:linked");
  }),
}));

vi.mock("../src/core/events/emitter.js", () => ({
  emitEvent: vi.fn(async () => {}),
  recordMandatoryAudit: vi.fn(async (_db: unknown, args: { type: string }) => {
    if (h.auditFailOn && args.type === h.auditFailOn) {
      throw new Error(`injected failure on ${args.type}`);
    }
    h.order.push(args.type);
  }),
}));

vi.mock("../src/core/engine/events.js", () => ({
  taskEvents: {
    emitTaskEvent: vi.fn((e: { type: string }) => {
      h.busEvents.push(e.type);
    }),
  },
}));

vi.mock("../src/core/db/queries/assets.js", () => ({
  createAsset: vi.fn(async (args: { identifier: string }) => {
    h.order.push("asset:created");
    return { id: "asset-1", identifier: args.identifier };
  }),
}));

import { processAdapterResult, transitionTask } from "../src/core/engine/taskManager.js";
import {
  getTransactionById,
  setTransactionStatus,
} from "../src/core/db/queries/transactions.js";

function statusWrites(): string[] {
  return h.order.filter((o) => o.startsWith("status:")).map((o) => o.slice("status:".length));
}

describe("task finalization", () => {
  beforeEach(() => {
    h.tx.status = "working";
    h.tx.version = 1;
    h.tx.metadata = {};
    h.order.length = 0;
    h.busEvents.length = 0;
    h.auditFailOn = null;
    vi.clearAllMocks();
  });

  it("persists artifacts and asset before the terminal status write", async () => {
    await processAdapterResult(
      "task-1",
      {
        status: "completed",
        message: "done",
        artifacts: [{ name: "receipt", data: { ok: true } }],
        asset: { assetType: "item", assetIdentifier: "sample-item", assetData: {} },
      },
      "svc-1",
    );

    const artifactIdx = h.order.indexOf("transaction.artifact.created");
    const assetIdx = h.order.indexOf("asset:created");
    const completedIdx = h.order.findIndex((o) => o.startsWith("status:completed"));
    expect(artifactIdx).toBeGreaterThanOrEqual(0);
    expect(assetIdx).toBeGreaterThan(artifactIdx);
    expect(completedIdx).toBeGreaterThan(assetIdx);
  });

  it("does not finalize the task when an artifact write fails", async () => {
    h.auditFailOn = "transaction.artifact.created";

    await expect(
      processAdapterResult(
        "task-1",
        { status: "completed", message: "done", artifacts: [{ name: "receipt", data: {} }] },
        "svc-1",
      ),
    ).rejects.toThrow(/injected failure/);

    expect(statusWrites().find((s) => s.startsWith("completed"))).toBeUndefined();
    // Nothing was announced on the bus for a finalization that failed.
    expect(h.busEvents).toHaveLength(0);
  });

  it("bridges input-required → completed through working (core, no service bridge)", async () => {
    h.tx.status = "input-required";
    await processAdapterResult("task-1", { status: "completed", message: "done" }, "svc-1");
    expect(statusWrites()).toEqual(["working<-input-required", "completed<-working"]);
  });

  it("bridges input-required → failed through working", async () => {
    h.tx.status = "input-required";
    await processAdapterResult(
      "task-1",
      { status: "failed", message: "gave up", error: "supplier says no" },
      "svc-1",
    );
    expect(statusWrites()).toEqual(["working<-input-required", "failed<-working"]);
  });

  it("takes the direct edge when the state machine allows it (submitted → failed)", async () => {
    h.tx.status = "submitted";
    await processAdapterResult("task-1", { status: "failed", message: "rejected" }, "svc-1");
    expect(statusWrites()).toEqual(["failed<-submitted"]);
  });

  it("emits a progress message for same-status working results without a transition", async () => {
    await processAdapterResult("task-1", { status: "working", message: "step 2 of 5" }, "svc-1");
    expect(statusWrites()).toHaveLength(0);
    expect(h.order).toContain("transaction.message.agent");
  });
});

describe("transitionTask", () => {
  beforeEach(() => {
    h.tx.status = "working";
    h.tx.version = 1;
    h.busEvents.length = 0;
    h.order.length = 0;
    vi.clearAllMocks();
  });

  it("fires bus events only after the transition commits", async () => {
    await transitionTask("task-1", "completed", "all done");
    expect(h.busEvents).toEqual(["transition"]);
  });

  it("returns the winner idempotently when the CAS loses to the same target", async () => {
    vi.mocked(setTransactionStatus).mockResolvedValueOnce(null);
    vi.mocked(getTransactionById)
      .mockResolvedValueOnce({ ...h.tx, status: "working" } as never)
      .mockResolvedValueOnce({ ...h.tx, status: "completed" } as never);

    const row = await transitionTask("task-1", "completed");
    expect(row.status).toBe("completed");
  });

  it("throws a typed conflict when the CAS loses to a different terminal state", async () => {
    vi.mocked(setTransactionStatus).mockResolvedValueOnce(null);
    vi.mocked(getTransactionById)
      .mockResolvedValueOnce({ ...h.tx, status: "working" } as never)
      .mockResolvedValueOnce({ ...h.tx, status: "canceled", version: 3 } as never);

    await expect(transitionTask("task-1", "completed")).rejects.toMatchObject({
      name: "TaskTransitionConflict",
    });
    expect(h.busEvents).toHaveLength(0);
  });
});

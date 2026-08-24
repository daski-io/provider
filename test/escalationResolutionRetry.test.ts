import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceRow } from "../src/core/db/queries/services.js";
import type { SkillRow } from "../src/core/db/queries/skills.js";
import {
  buildExecutionSnapshot,
  sealExecutionSnapshot,
} from "../src/core/engine/escalationSnapshot.js";

const mocks = vi.hoisted(() => ({
  state: null as Record<string, unknown> | null,
  stealClaim: false,
  enqueue: vi.fn(),
  audit: vi.fn(),
  db: {
    async query(text: string, values: unknown[] = []) {
      const state = mocks.state!;
      if (text.includes("SELECT * FROM escalations")) {
        const row = { ...state };
        /// Emulates a concurrent worker winning between SELECT ... FOR UPDATE
        /// and the guarded UPDATE.
        if (mocks.stealClaim) {
          state.status = "resolution_queued";
          mocks.stealClaim = false;
        }
        return { rows: [row], rowCount: 1 };
      }
      if (text.includes("status='resolution_attention'")) {
        if (state.status !== "resolution_attention") return { rows: [], rowCount: 0 };
        state.status = values[1];
        state.resolution_job_id = values[2];
        state.resolution_error = null;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("reviewer_decision = $4")) {
        if (state.status !== "pending") return { rows: [], rowCount: 0 };
        Object.assign(state, {
          status: values[1],
          response: values[2],
          reviewer_decision: values[3],
          reviewer_actor: values[4],
          reviewer_edits_encrypted: values[5],
          reviewer_edits_hash: values[6],
          review_binding_encrypted: values[7],
          review_binding_hash: values[8],
        });
        return { rows: [{ ...state }], rowCount: 1 };
      }
      if (text.includes("resolution_job_id")) {
        state.resolution_job_id = values[1];
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL in retry test: ${text}`);
    },
  },
}));

vi.mock("../src/core/db/pool.js", () => ({ pool: {} }));
vi.mock("../src/core/db/queryable.js", () => ({
  inTransaction: async (_pool: unknown, work: (db: typeof mocks.db) => unknown) => work(mocks.db),
}));
vi.mock("../src/core/db/queries/durableJobs.js", () => ({
  enqueueDurableJob: mocks.enqueue,
}));
vi.mock("../src/core/events/emitter.js", () => ({
  recordMandatoryAudit: mocks.audit,
}));

const { claimPreExecuteResolution, retryResolutionAttention } = await import(
  "../src/core/engine/escalationResolutionStore.js"
);

const service = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "sample-service",
  version: "1",
  adapter_name: "sample-service",
  config_revision: "1",
} as ServiceRow;
const skill = {
  id: "22222222-2222-4222-8222-222222222222",
  service_id: service.id,
  skill_id: "create-record",
  required_fields: ["ssn"],
  optional_fields: [],
  updated_at: new Date("2026-07-10T00:00:00.000Z"),
} as unknown as SkillRow;

const ESCALATION_ID = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  const snapshot = buildExecutionSnapshot({
    transactionId: "task-retry",
    customerId: "55555555-5555-4555-8555-555555555555",
    requestData: { ssn: "123-45-6789" },
    service,
    skill,
    asset: null,
  });
  const sealed = sealExecutionSnapshot(ESCALATION_ID, snapshot);
  mocks.state = {
    id: ESCALATION_ID,
    transaction_id: "task-retry",
    question: "review",
    source: "pre_execute",
    status: "pending",
    response: null,
    edited_data: null,
    assignee: null,
    agent_recommendation: null,
    inbound_id: null,
    thread_id: null,
    created_at: new Date(),
    resolved_at: null,
    resolved_by: null,
    execution_snapshot_encrypted: sealed.encrypted,
    execution_snapshot_hash: sealed.snapshotHash,
    request_hash: snapshot.requestHash,
    snapshot_version: 1,
    snapshot_service_id: service.id,
    snapshot_skill_id: skill.skill_id,
    snapshot_asset_id: null,
    reviewer_decision: null,
    reviewer_actor: null,
    reviewer_edits_encrypted: null,
    reviewer_edits_hash: null,
    review_binding_encrypted: null,
    review_binding_hash: null,
    adapter_result_encrypted: null,
    adapter_result_hash: null,
    resolution_job_id: null,
    resolution_error: null,
  };
  mocks.stealClaim = false;
  mocks.enqueue.mockReset().mockResolvedValue({ id: "job-1" });
  mocks.audit.mockReset().mockResolvedValue(undefined);
});

/// Drives the row through the real claim path so the sealed review evidence
/// the retry reopens is genuine, then parks it in resolution_attention the
/// way a failed resolution job would.
async function seedAttention(decision: "approved" | "rejected") {
  const claim = await claimPreExecuteResolution({
    escalationId: ESCALATION_ID,
    decision,
    actor: "reviewer-a",
  });
  expect(claim.claimed).toBe(true);
  mocks.state!.status = "resolution_attention";
  mocks.state!.resolution_error = "supplier timeout";
  mocks.enqueue.mockClear();
  mocks.audit.mockClear();
}

describe("operator retry of a resolution needing attention", () => {
  it("requeues an approved resolution and audits the operator action", async () => {
    await seedAttention("approved");
    await expect(
      retryResolutionAttention({ escalationId: ESCALATION_ID, actor: "operator-a" }),
    ).resolves.toBe(true);
    expect(mocks.state!.status).toBe("resolution_queued");
    expect(mocks.state!.resolution_error).toBeNull();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.stringContaining(":operator-retry:"),
      payload: { escalationId: ESCALATION_ID },
    }));
    expect(mocks.audit).toHaveBeenCalledWith(mocks.db, expect.objectContaining({
      type: "review.resolution.retried",
      actor: "operator-a",
    }));
  });

  it("requeues a rejected resolution into the rejection queue", async () => {
    await seedAttention("rejected");
    await expect(
      retryResolutionAttention({ escalationId: ESCALATION_ID, actor: "operator-a" }),
    ).resolves.toBe(true);
    expect(mocks.state!.status).toBe("rejection_queued");
  });

  it("refuses rows that are not parked in resolution_attention", async () => {
    await seedAttention("approved");
    mocks.state!.status = "resolution_queued";
    await expect(
      retryResolutionAttention({ escalationId: ESCALATION_ID, actor: "operator-a" }),
    ).resolves.toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("refuses rows that never recorded a reviewer decision", async () => {
    mocks.state!.status = "resolution_attention";
    await expect(
      retryResolutionAttention({ escalationId: ESCALATION_ID, actor: "operator-a" }),
    ).resolves.toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("requires a review actor", async () => {
    await expect(
      retryResolutionAttention({ escalationId: ESCALATION_ID, actor: "  " }),
    ).rejects.toThrow("review actor is required");
  });

  it("surfaces a lost claim instead of silently double-queueing", async () => {
    await seedAttention("approved");
    mocks.stealClaim = true;
    await expect(
      retryResolutionAttention({ escalationId: ESCALATION_ID, actor: "operator-a" }),
    ).rejects.toThrow("review retry claim was lost");
  });
});

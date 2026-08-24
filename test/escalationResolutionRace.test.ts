import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceRow } from "../src/core/db/queries/services.js";
import type { SkillRow } from "../src/core/db/queries/skills.js";
import {
  buildExecutionSnapshot,
  sealExecutionSnapshot,
} from "../src/core/engine/escalationSnapshot.js";

const mocks = vi.hoisted(() => ({
  state: null as Record<string, unknown> | null,
  enqueue: vi.fn(),
  audit: vi.fn(),
  db: {
    async query(text: string, values: unknown[] = []) {
      const state = mocks.state!;
      if (text.includes("SELECT * FROM escalations")) return { rows: [{ ...state }], rowCount: 1 };
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
      throw new Error(`unexpected SQL in race test: ${text}`);
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

const { claimPreExecuteResolution } = await import(
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

beforeEach(() => {
  const id = "44444444-4444-4444-8444-444444444444";
  const snapshot = buildExecutionSnapshot({
    transactionId: "task-race",
    customerId: "55555555-5555-4555-8555-555555555555",
    requestData: { ssn: "123-45-6789" },
    service,
    skill,
    asset: null,
  });
  const sealed = sealExecutionSnapshot(id, snapshot);
  mocks.state = {
    id,
    transaction_id: "task-race",
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
  };
  mocks.enqueue.mockReset().mockResolvedValue({ id: "job-1" });
  mocks.audit.mockReset().mockResolvedValue(undefined);
});

describe("atomic escalation resolution claim", () => {
  it.each([
    ["approve/approve", "approved", "approved"],
    ["approve/reject", "approved", "rejected"],
    ["approve/timeout", "approved", "rejected"],
  ] as const)("allows one winner for %s and gives the loser no durable effect", async (_name, a, b) => {
    const [first, second] = await Promise.all([
      claimPreExecuteResolution({
        escalationId: String(mocks.state!.id),
        decision: a,
        actor: "reviewer-a",
      }),
      claimPreExecuteResolution({
        escalationId: String(mocks.state!.id),
        decision: b,
        actor: b === "rejected" ? "system:escalation-timeout" : "reviewer-b",
      }),
    ]);

    expect([first.claimed, second.claimed].filter(Boolean)).toHaveLength(1);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(["resolution_queued", "rejection_queued"]).toContain(mocks.state!.status);
  });

  it("keeps reviewer free text only in protected evidence", async () => {
    const result = await claimPreExecuteResolution({
      escalationId: String(mocks.state!.id),
      decision: "rejected",
      actor: "reviewer-a",
      response: "Jane Doe 123-45-6789 should be rejected",
    });
    expect(result.claimed).toBe(true);
    expect(String(mocks.state!.response)).toMatch(/^daski:v1:/);
    expect(String(mocks.state!.response)).not.toContain("Jane Doe");
    expect(String(mocks.state!.response)).not.toContain("123-45-6789");
    expect(String(mocks.state!.review_binding_encrypted)).not.toContain("Jane Doe");
  });
});

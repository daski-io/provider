import { describe, expect, it } from "vitest";
import type { AssetRow } from "../src/core/db/queries/assets.js";
import type { ServiceRow } from "../src/core/db/queries/services.js";
import type { SkillRow } from "../src/core/db/queries/skills.js";
import type { AdapterResult } from "../src/core/serviceRegistry/types.js";
import {
  buildExecutionSnapshot,
  openAdapterResult,
  openExecutionSnapshot,
  openReviewEvidence,
  sealAdapterResult,
  sealExecutionSnapshot,
  sealReviewEvidence,
  validateAndMergeReviewerEdits,
  hashCanonical,
  type SnapshotEvidenceRow,
} from "../src/core/engine/escalationSnapshot.js";

const service = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "sample-service",
  version: "1",
  adapter_name: "sample-service",
  config_revision: "7",
} as ServiceRow;

const skill = {
  id: "22222222-2222-4222-8222-222222222222",
  service_id: service.id,
  skill_id: "create-record",
  required_fields: ["displayName", "secretToken"],
  optional_fields: ["note"],
  updated_at: new Date("2026-07-10T12:00:00.000Z"),
} as SkillRow;

const asset = {
  id: "33333333-3333-4333-8333-333333333333",
  service_id: service.id,
  type: "item",
  identifier: "item:secure-1",
  status: "active",
  metadata: { supplierItemId: "supplier-42" },
  created_at: new Date("2026-07-01T00:00:00.000Z"),
  expires_at: new Date("2027-07-01T00:00:00.000Z"),
} satisfies AssetRow;

function sealedRow(id = "44444444-4444-4444-8444-444444444444") {
  const snapshot = buildExecutionSnapshot({
    transactionId: "task-sensitive",
    customerId: "55555555-5555-4555-8555-555555555555",
    requestData: {
      displayName: "Secure Item",
      secretToken: "private-token-987",
      nested: { reference: "private-reference" },
    },
    service,
    skill,
    asset,
    now: new Date("2026-07-10T13:00:00.000Z"),
  });
  const sealed = sealExecutionSnapshot(id, snapshot);
  const row: SnapshotEvidenceRow = {
    id,
    execution_snapshot_encrypted: sealed.encrypted,
    execution_snapshot_hash: sealed.snapshotHash,
    request_hash: snapshot.requestHash,
    snapshot_version: 1,
    snapshot_service_id: service.id,
  };
  return { snapshot, row };
}

describe("pre-execute escalation evidence", () => {
  it("preserves protected request values and exact asset context only inside ciphertext", () => {
    const { snapshot, row } = sealedRow();
    expect(row.execution_snapshot_encrypted).not.toContain("private-token-987");
    expect(row.execution_snapshot_encrypted).not.toContain("supplier-42");

    const opened = openExecutionSnapshot(row);
    expect(opened.requestData).toEqual(snapshot.requestData);
    expect(opened.asset).toEqual(snapshot.asset);
    expect(opened.asset?.id).toBe(asset.id);
  });

  it("rejects ciphertext transplant, canonical hash drift, and request drift", () => {
    const { row } = sealedRow();
    expect(() => openExecutionSnapshot({ ...row, id: "66666666-6666-4666-8666-666666666666" })).toThrow();
    expect(() => openExecutionSnapshot({ ...row, execution_snapshot_hash: "0".repeat(64) })).toThrow(/hash mismatch/);
    expect(() => openExecutionSnapshot({ ...row, request_hash: `0x${"00".repeat(32)}` })).toThrow(/request hash/);
  });

  it("binds immutable reviewer actor, decision, edits, and snapshot hash", () => {
    const { row } = sealedRow();
    const edits = { displayName: "Reviewed Item" };
    const binding = {
      decision: "edited" as const,
      actor: "0xreviewer",
      response: "verified",
      editsHash: hashCanonical(edits),
      snapshotHash: row.execution_snapshot_hash,
    };
    const sealed = sealReviewEvidence({ row, binding, edits });
    const boundRow = {
      ...row,
      reviewer_decision: binding.decision,
      reviewer_actor: binding.actor,
      reviewer_edits_encrypted: sealed.editsEncrypted,
      reviewer_edits_hash: sealed.editsHash,
      review_binding_encrypted: sealed.bindingEncrypted,
      review_binding_hash: sealed.bindingHash,
    };
    expect(openReviewEvidence(boundRow)).toEqual({ binding, edits });
    expect(() => openReviewEvidence({ ...boundRow, reviewer_actor: "0xattacker" })).toThrow(/binding mismatch/);
    expect(() => openReviewEvidence({ ...boundRow, reviewer_edits_hash: "bad" })).toThrow(/edits hash/);
  });

  it("validates reviewer edit keys and required-field preservation", () => {
    const { snapshot } = sealedRow();
    expect(validateAndMergeReviewerEdits(snapshot, { displayName: "Edited Item" })).toMatchObject({
      displayName: "Edited Item",
      secretToken: "private-token-987",
    });
    expect(() => validateAndMergeReviewerEdits(snapshot, { unreviewed: true })).toThrow(/unknown fields/);
    expect(() => validateAndMergeReviewerEdits(snapshot, { secretToken: undefined })).toThrow(/required fields/);
    expect(() => validateAndMergeReviewerEdits(snapshot, JSON.parse('{"__proto__":"bad"}'))).toThrow(/forbidden key/);
  });

  it("seals asset-less adapter results without introducing undefined values", () => {
    const { row } = sealedRow();
    const result = {
      status: "completed",
      message: "Item updated.",
      artifacts: [{ name: "update_receipt", data: { reference: "123" } }],
    } satisfies AdapterResult;

    const sealed = sealAdapterResult(row, result);
    expect(openAdapterResult({
      ...row,
      adapter_result_encrypted: sealed.encrypted,
      adapter_result_hash: sealed.hash,
    })).toEqual(result);
  });

  it("omits absent asset expiry instead of storing undefined", () => {
    const { row } = sealedRow();
    const result = {
      status: "completed",
      asset: {
        assetType: "item",
        assetIdentifier: "item:created-1",
        assetData: { supplierId: "sample-123" },
      },
    } satisfies AdapterResult;

    const sealed = sealAdapterResult(row, result);
    expect(openAdapterResult({
      ...row,
      adapter_result_encrypted: sealed.encrypted,
      adapter_result_hash: sealed.hash,
    })).toEqual(result);
  });
});

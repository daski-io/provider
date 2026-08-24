import { createHash } from "node:crypto";
import {
  canonicalJsonStringify,
  computeRequestHash,
} from "../auth/requestHash.js";
import { decryptString, encryptString } from "../chain/encryption.js";
import type { AssetRow } from "../db/queries/assets.js";
import type { ServiceRow } from "../db/queries/services.js";
import type { SkillRow } from "../db/queries/skills.js";
import type { AdapterResult } from "../serviceRegistry/types.js";
import { adapterResultForStorage } from "./adapterResultSerialization.js";

export const ESCALATION_SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 1_000_000;
const MAX_EDITS_BYTES = 64_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export interface ExecutionSnapshot {
  version: 1;
  createdAt: string;
  transactionId: string;
  customerId: string | null;
  requestHash: string;
  requestData: Record<string, unknown>;
  service: {
    id: string;
    slug: string;
    version: string;
    adapterName: string;
    configRevision: string;
  };
  skill: {
    id: string;
    serviceId: string;
    skillId: string;
    requiredFields: string[];
    optionalFields: string[];
    updatedAt: string;
  };
  asset: {
    id: string;
    serviceId: string;
    type: string;
    identifier: string;
    status: AssetRow["status"];
    metadata: Record<string, unknown>;
    createdAt: string;
    expiresAt: string | null;
  } | null;
}

export interface SnapshotEvidenceRow {
  id: string;
  execution_snapshot_encrypted: string;
  execution_snapshot_hash: string;
  request_hash: string;
  snapshot_version: number;
  snapshot_service_id: string;
  reviewer_decision?: string | null;
  reviewer_actor?: string | null;
  reviewer_edits_encrypted?: string | null;
  reviewer_edits_hash?: string | null;
  review_binding_encrypted?: string | null;
  review_binding_hash?: string | null;
  adapter_result_encrypted?: string | null;
  adapter_result_hash?: string | null;
}

export interface ReviewBinding {
  decision: "approved" | "edited" | "rejected";
  actor: string;
  response: string;
  editsHash: string | null;
  snapshotHash: string;
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value), "utf8").digest("hex");
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isPlainObject(parsed)) throw new Error(`${label} is not an object`);
  return parsed;
}

function evidenceContext(row: Pick<SnapshotEvidenceRow, "id" | "snapshot_service_id">, field: string) {
  return {
    purpose: `escalation-${field}`,
    table: "escalations",
    recordId: row.id,
    field,
    service: row.snapshot_service_id,
    recordVersion: ESCALATION_SNAPSHOT_VERSION,
  } as const;
}

export function buildExecutionSnapshot(args: {
  transactionId: string;
  customerId: string | null;
  requestData: Record<string, unknown>;
  service: ServiceRow;
  skill: SkillRow;
  asset: AssetRow | null;
  now?: Date;
}): ExecutionSnapshot {
  assertSafeObject(args.requestData, "request data");
  const snapshot: ExecutionSnapshot = {
    version: ESCALATION_SNAPSHOT_VERSION,
    createdAt: (args.now ?? new Date()).toISOString(),
    transactionId: args.transactionId,
    customerId: args.customerId,
    requestHash: computeRequestHash(args.requestData),
    requestData: args.requestData,
    service: {
      id: args.service.id,
      slug: args.service.slug,
      version: args.service.version,
      adapterName: args.service.adapter_name,
      configRevision: args.service.config_revision,
    },
    skill: {
      id: args.skill.id,
      serviceId: args.skill.service_id,
      skillId: args.skill.skill_id,
      requiredFields: args.skill.required_fields ?? [],
      optionalFields: args.skill.optional_fields ?? [],
      updatedAt: args.skill.updated_at.toISOString(),
    },
    asset: args.asset ? {
      id: args.asset.id,
      serviceId: args.asset.service_id,
      type: args.asset.type,
      identifier: args.asset.identifier,
      status: args.asset.status,
      metadata: args.asset.metadata,
      createdAt: args.asset.created_at.toISOString(),
      expiresAt: args.asset.expires_at?.toISOString() ?? null,
    } : null,
  };
  if (Buffer.byteLength(canonicalJsonStringify(snapshot), "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new Error("execution snapshot exceeds protected-data limit");
  }
  return snapshot;
}

export function sealExecutionSnapshot(
  id: string,
  snapshot: ExecutionSnapshot,
): { encrypted: string; snapshotHash: string } {
  const plaintext = canonicalJsonStringify(snapshot);
  return {
    encrypted: encryptString(plaintext, evidenceContext({ id, snapshot_service_id: snapshot.service.id }, "execution-snapshot")),
    snapshotHash: hashCanonical(snapshot),
  };
}

export function openExecutionSnapshot(row: SnapshotEvidenceRow): ExecutionSnapshot {
  if (row.snapshot_version !== ESCALATION_SNAPSHOT_VERSION) {
    throw new Error(`unsupported escalation snapshot version ${row.snapshot_version}`);
  }
  const plaintext = decryptString(
    row.execution_snapshot_encrypted,
    evidenceContext(row, "execution-snapshot"),
  );
  const parsed = parseObject(plaintext, "execution snapshot") as unknown as ExecutionSnapshot;
  if (hashCanonical(parsed) !== row.execution_snapshot_hash) {
    throw new Error("execution snapshot hash mismatch");
  }
  if (parsed.version !== 1 || parsed.service.id !== row.snapshot_service_id) {
    throw new Error("execution snapshot context mismatch");
  }
  if (computeRequestHash(parsed.requestData) !== row.request_hash || parsed.requestHash !== row.request_hash) {
    throw new Error("execution snapshot request hash mismatch");
  }
  assertSafeObject(parsed.requestData, "snapshot request data");
  return parsed;
}

export function validateAndMergeReviewerEdits(
  snapshot: ExecutionSnapshot,
  edits: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (edits === undefined) return snapshot.requestData;
  assertSafeObject(edits, "reviewer edits");
  const allowed = new Set([
    ...Object.keys(snapshot.requestData),
    ...snapshot.skill.requiredFields,
    ...snapshot.skill.optionalFields,
  ]);
  const unknown = Object.keys(edits).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`reviewer edits contain unknown fields: ${unknown.join(", ")}`);
  const merged = { ...snapshot.requestData, ...edits };
  const missing = snapshot.skill.requiredFields.filter((key) => merged[key] === undefined);
  if (missing.length > 0) throw new Error(`reviewer edits remove required fields: ${missing.join(", ")}`);
  if (Buffer.byteLength(canonicalJsonStringify(edits), "utf8") > MAX_EDITS_BYTES) {
    throw new Error("reviewer edits exceed size limit");
  }
  return merged;
}

export function sealReviewEvidence(args: {
  row: Pick<SnapshotEvidenceRow, "id" | "snapshot_service_id">;
  binding: ReviewBinding;
  edits?: Record<string, unknown>;
}): { bindingEncrypted: string; bindingHash: string; editsEncrypted: string | null; editsHash: string | null } {
  const editsHash = args.edits ? hashCanonical(args.edits) : null;
  if (editsHash !== args.binding.editsHash) throw new Error("review binding edits hash mismatch");
  return {
    bindingEncrypted: encryptString(canonicalJsonStringify(args.binding), evidenceContext(args.row, "review-binding")),
    bindingHash: hashCanonical(args.binding),
    editsEncrypted: args.edits
      ? encryptString(canonicalJsonStringify(args.edits), evidenceContext(args.row, "reviewer-edits"))
      : null,
    editsHash,
  };
}

export function openReviewEvidence(row: SnapshotEvidenceRow): {
  binding: ReviewBinding;
  edits?: Record<string, unknown>;
} {
  if (!row.review_binding_encrypted || !row.review_binding_hash) throw new Error("review binding is missing");
  const binding = parseObject(
    decryptString(row.review_binding_encrypted, evidenceContext(row, "review-binding")),
    "review binding",
  ) as unknown as ReviewBinding;
  if (hashCanonical(binding) !== row.review_binding_hash ||
      binding.actor !== row.reviewer_actor || binding.decision !== row.reviewer_decision ||
      binding.snapshotHash !== row.execution_snapshot_hash) {
    throw new Error("review binding mismatch");
  }
  if (!row.reviewer_edits_encrypted) {
    if (binding.editsHash !== null || row.reviewer_edits_hash !== null) throw new Error("review edits binding mismatch");
    return { binding };
  }
  const edits = parseObject(
    decryptString(row.reviewer_edits_encrypted, evidenceContext(row, "reviewer-edits")),
    "reviewer edits",
  );
  if (hashCanonical(edits) !== row.reviewer_edits_hash || binding.editsHash !== row.reviewer_edits_hash) {
    throw new Error("reviewer edits hash mismatch");
  }
  assertSafeObject(edits, "reviewer edits");
  return { binding, edits };
}

export function sealAdapterResult(row: SnapshotEvidenceRow, result: AdapterResult) {
  const serializable = adapterResultForStorage(result);
  return {
    encrypted: encryptString(canonicalJsonStringify(serializable), evidenceContext(row, "adapter-result")),
    hash: hashCanonical(serializable),
  };
}

export function openAdapterResult(row: SnapshotEvidenceRow): AdapterResult {
  if (!row.adapter_result_encrypted || !row.adapter_result_hash) throw new Error("adapter result is missing");
  const parsed = parseObject(
    decryptString(row.adapter_result_encrypted, evidenceContext(row, "adapter-result")),
    "adapter result",
  );
  if (hashCanonical(parsed) !== row.adapter_result_hash) throw new Error("adapter result hash mismatch");
  const result = parsed as unknown as AdapterResult;
  if (result.asset?.expiresAt) result.asset.expiresAt = new Date(result.asset.expiresAt);
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertSafeObject(value: Record<string, unknown>, label: string): void {
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) return entry.forEach(visit);
    if (entry === null || typeof entry !== "object") return;
    if (!isPlainObject(entry)) throw new Error(`${label} contains a non-JSON object`);
    for (const [key, child] of Object.entries(entry)) {
      if (FORBIDDEN_KEYS.has(key)) throw new Error(`${label} contains forbidden key '${key}'`);
      visit(child);
    }
  };
  visit(value);
}

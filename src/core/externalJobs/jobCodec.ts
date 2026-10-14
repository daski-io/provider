import type { JsonRecord } from "../serviceRegistry/types.js";
import {
  decryptField,
  encryptField,
  fieldKeyId,
  type FieldContext,
  type FieldEncryptionKeyRing,
} from "../security/fieldEncryption.js";
import { canonicalJson } from "../standardRail/canonical.js";
import { assertBoundedJsonValue, REQUEST_JSON_BUDGET } from "../standardRail/jsonBounds.js";
import { MAX_RESULT_BYTES } from "../standardRail/serviceResult.js";
import { JOB_TABLE } from "./phases.js";

/** The canonical JSON bound of a stored job input; a request above it is never admitted. */
export const MAX_JOB_INPUT_BYTES = 1_048_576;
/** A job reference is a small versioned handle, never an upstream body (L02). */
export const MAX_JOB_REFERENCE_BYTES = 16_384;

export type JobField = "input" | "reference" | "candidate";

const COLUMNS: Readonly<Record<JobField, { purpose: string; field: string }>> = {
  input: { purpose: "external-job/input", field: "input_ciphertext" },
  reference: { purpose: "external-job/reference", field: "job_reference_ciphertext" },
  candidate: { purpose: "external-job/result-candidate", field: "result_candidate_ciphertext" },
};

/** One sealed field: the envelope and the key id it names, stored side by side. */
export interface SealedField {
  ciphertext: string;
  keyId: string;
}

const contextOf = (kind: JobField, taskId: string, serviceSlug: string): FieldContext => ({
  purpose: COLUMNS[kind].purpose,
  table: JOB_TABLE,
  recordId: taskId,
  field: COLUMNS[kind].field,
  service: serviceSlug,
});

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

/** A plain JSON object snapshot, or null; getters and prototypes do not survive. */
function jsonObject(value: unknown): JsonRecord | null {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(JSON.stringify(value) ?? "null");
  } catch {
    return null;
  }
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot as JsonRecord : null;
}

/** Whether a validated request fits a job's stored input. */
export function jobInputFits(input: JsonRecord): boolean {
  try {
    return byteLength(canonicalJson(input)) <= MAX_JOB_INPUT_BYTES;
  } catch {
    return false;
  }
}

/**
 * The upstream job reference an adapter returned, as stored: a plain JSON
 * object within the request budget and 16 KiB of canonical JSON; null when
 * it is not one. Core never interprets it.
 */
export function boundedJobReference(job: unknown): JsonRecord | null {
  const reference = jsonObject(job);
  if (!reference) return null;
  try {
    assertBoundedJsonValue(reference, REQUEST_JSON_BUDGET, "Job reference");
    return byteLength(canonicalJson(reference)) <= MAX_JOB_REFERENCE_BYTES ? reference : null;
  } catch {
    return null;
  }
}

/** Seal a job field under the active key, bound to its job row and column. */
export function sealJobField(
  ring: FieldEncryptionKeyRing,
  kind: JobField,
  job: { taskId: string; serviceSlug: string },
  value: unknown,
): SealedField {
  return encryptField(ring, canonicalJson(value), contextOf(kind, job.taskId, job.serviceSlug));
}

/**
 * A result candidate is kept only when it is safe to keep: storable and
 * within the result byte bound. Null means it was not retained.
 */
export function sealResultCandidate(
  ring: FieldEncryptionKeyRing,
  job: { taskId: string; serviceSlug: string },
  candidate: unknown,
): SealedField | null {
  try {
    const encoded = canonicalJson(candidate);
    if (byteLength(encoded) > MAX_RESULT_BYTES) return null;
    return encryptField(ring, encoded, contextOf("candidate", job.taskId, job.serviceSlug));
  } catch {
    return null;
  }
}

/** Open a sealed job field; it must name the key id stored beside it. */
export function openJobField(
  ring: FieldEncryptionKeyRing,
  kind: JobField,
  job: { taskId: string; serviceSlug: string },
  sealed: SealedField,
): JsonRecord {
  if (fieldKeyId(sealed.ciphertext) !== sealed.keyId) {
    throw new Error("Stored external-job field names another key than its column");
  }
  const plaintext = decryptField(ring, sealed.ciphertext, contextOf(kind, job.taskId, job.serviceSlug));
  const value = JSON.parse(plaintext) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored external-job field is not an object");
  }
  return value as JsonRecord;
}

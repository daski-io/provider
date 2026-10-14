import type { ValidateFunction } from "ajv";
import { isPassiveOutput, type ServiceResult } from "../serviceRegistry/types.js";
import { canonicalHash } from "./canonical.js";
import { assertBoundedJsonValue, RESPONSE_JSON_BUDGET } from "./jsonBounds.js";

/** The adapter threw, timed out, or returned no reviewed terminal result. */
export const SERVICE_EXECUTION_FAILED = "service_execution_failed";
/** A completed result failed the admitted result schema or core's bounds. */
export const SERVICE_RESULT_INVALID = "service_result_invalid";
/**
 * A pre-R1 execution interrupted by a restart, as that image attested it and
 * as the stop-and-drain cutover resolves the ones it left executing.
 */
export const PROVIDER_RESTARTED_DURING_EXECUTION = "provider_restarted_during_execution";
/** A synchronous execution whose owner stopped renewing its lease. */
export const SYNC_EXECUTION_ABANDONED = "provider_execution_abandoned";
/** Codes core may always attest; services add their own reviewed codes. */
export const CORE_FAILURE_CODES: ReadonlySet<string> = new Set([
  SERVICE_EXECUTION_FAILED, SERVICE_RESULT_INVALID, PROVIDER_RESTARTED_DURING_EXECUTION,
  SYNC_EXECUTION_ABANDONED,
]);
export const FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
export const MAX_RESULT_BYTES = 1_000_000;
const MAX_ARTIFACTS = 20;
const ARTIFACT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Failure evidence carries a reviewed code and never free text. */
export interface FailureEvidence {
  status: "failed";
  errorCode: string;
}

export const failureEvidence = (errorCode: string): FailureEvidence =>
  ({ status: "failed", errorCode });

/** What a terminal result is held to before it is frozen. */
export interface ResultContract {
  /** The admitted resultSchema of the dispatched listing version, compiled. */
  validate: ValidateFunction;
  /** The service's reviewed failure codes; any other code becomes the generic one. */
  failureCodes: ReadonlySet<string>;
}

/** A stable diagnostic name plus schema-derived keywords; never result content. */
export interface ResultDiagnostic {
  code: "result_artifact_invalid" | "result_unstorable" | "result_out_of_bounds"
    | "result_active_content" | "result_schema_mismatch";
  keywords: string[];
}

class InvalidResult extends Error {
  constructor(readonly diagnostic: ResultDiagnostic) {
    super(diagnostic.code);
    this.name = "InvalidResult";
  }
}

const invalid = (code: ResultDiagnostic["code"], keywords: string[] = []) =>
  new InvalidResult({ code, keywords });

/**
 * The single result frozen for a terminal task. A completed result is the
 * complete canonical ServiceResult: normalized to the stored JSON form, held
 * to core's artifact and byte bounds, the response JSON budget, the
 * gateway's passive-output rule and the admitted resultSchema as one whole
 * object, so it is never frozen as completed when the gateway would refuse
 * to relay it. A failure becomes `{status: "failed", errorCode}` with a
 * reviewed code; adapter messages are dropped, so free text never becomes
 * evidence. Nothing an adapter returns can make this throw.
 */
export function terminalServiceResult(
  value: unknown,
  contract: ResultContract,
): { result: ServiceResult; diagnostic?: ResultDiagnostic } {
  // Judge one JSON snapshot, which is exactly what is stored: getters,
  // proxies and undefined members cannot change or throw between checks.
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(JSON.stringify(value) ?? "null");
  } catch {
    return {
      result: failureEvidence(SERVICE_EXECUTION_FAILED),
      diagnostic: { code: "result_unstorable", keywords: [] },
    };
  }
  const record = snapshot as Record<string, unknown> | null;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { result: failureEvidence(SERVICE_EXECUTION_FAILED) };
  }
  if (record.status === "failed") {
    const code = record.errorCode;
    const reviewed = typeof code === "string" && FAILURE_CODE_PATTERN.test(code)
      && (contract.failureCodes.has(code) || CORE_FAILURE_CODES.has(code));
    return { result: failureEvidence(reviewed ? code : SERVICE_EXECUTION_FAILED) };
  }
  if (record.status !== "completed") return { result: failureEvidence(SERVICE_EXECUTION_FAILED) };
  try {
    return { result: completedResult(record as ServiceResult, contract.validate) };
  } catch (error) {
    const diagnostic = error instanceof InvalidResult
      ? error.diagnostic
      : { code: "result_unstorable" as const, keywords: [] };
    return { result: failureEvidence(SERVICE_RESULT_INVALID), diagnostic };
  }
}

/** Everything the gateway checks before it relays an artifact, and the stored form's limits. */
function completedResult(result: ServiceResult, validate: ValidateFunction): ServiceResult {
  try {
    assertStorable(result);
  } catch {
    throw invalid("result_unstorable");
  }
  try {
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESULT_BYTES) {
      throw new Error("Result exceeds the byte bound");
    }
    assertBoundedJsonValue(result, RESPONSE_JSON_BUDGET, "Result");
  } catch {
    throw invalid("result_out_of_bounds");
  }
  if (!isPassiveOutput(result)) throw invalid("result_active_content");
  assertArtifacts(result);
  if (!validate(result)) {
    const keywords = [...new Set((validate.errors ?? []).map((error) => error.keyword))].slice(0, 8);
    throw invalid("result_schema_mismatch", keywords);
  }
  return result;
}

function assertArtifacts(result: ServiceResult): void {
  if (result.status !== "completed") return;
  const artifacts: unknown = (result as { artifacts?: unknown }).artifacts;
  if (artifacts === undefined) return;
  if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACTS) {
    throw invalid("result_artifact_invalid");
  }
  for (const artifact of artifacts as Array<Record<string, unknown>>) {
    if (!artifact || typeof artifact.name !== "string" || !ARTIFACT_NAME.test(artifact.name)) {
      throw invalid("result_artifact_invalid");
    }
    if (artifact.url !== undefined) {
      let url: URL;
      try {
        url = new URL(String(artifact.url));
      } catch {
        throw invalid("result_artifact_invalid");
      }
      if (url.protocol !== "https:" || url.username || url.password) {
        throw invalid("result_artifact_invalid");
      }
    }
  }
}

/**
 * The stored and attested form is the JSON snapshot; refuse one PostgreSQL
 * jsonb or canonical hashing could not represent, so an admitted claim never
 * strands on an unstorable terminal write.
 */
function assertStorable(snapshot: unknown): void {
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (node.includes("\u0000")) throw new Error("Result contains U+0000");
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        visit(key);
        visit(child);
      }
    }
  };
  visit(snapshot);
  canonicalHash(snapshot);
}

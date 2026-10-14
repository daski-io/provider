import type {
  FulfillmentAdapter,
  ServiceResult,
  TaskContext,
} from "../serviceRegistry/types.js";
import { canonicalHash } from "./canonical.js";

const MAX_RESULT_BYTES = 1_000_000;
/** The synchronous mode's execution budget, not Daski's maximum service duration. */
export const MAX_EXECUTION_MS = 50_000;

/**
 * Run an admitted synchronous execution under the 50-second budget. A throw,
 * timeout, or invalid result becomes the generic failed result; adapter text
 * from a thrown error never reaches the buyer.
 */
export async function executeSynchronously(
  adapter: FulfillmentAdapter,
  context: Omit<TaskContext, "signal">,
  input: Record<string, unknown>,
): Promise<ServiceResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MAX_EXECUTION_MS);
    timeout.unref();
    let result: ServiceResult;
    try {
      result = await Promise.race([
        adapter.execute({ ...context, signal: controller.signal }, input),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("service execution timed out")),
            { once: true },
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    validateServiceResult(result);
    return persistableResult(result);
  } catch {
    return {
      status: "failed",
      errorCode: "service_execution_failed",
      message: "The provider could not complete this request.",
    };
  }
}

function validateServiceResult(result: ServiceResult): void {
  if (!result || (result.status !== "completed" && result.status !== "failed")) {
    throw new Error("Adapter must return a terminal result");
  }
  if (
    result.status === "failed"
    && !/^[a-z][a-z0-9_]{1,63}$/.test(result.errorCode)
  ) throw new Error("Adapter failure code is invalid");
  if (result.status === "completed") {
    if ((result.artifacts?.length ?? 0) > 20) throw new Error("Too many artifacts");
    for (const artifact of result.artifacts ?? []) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(artifact.name)) {
        throw new Error("Artifact name is invalid");
      }
      if (artifact.url) {
        const url = new URL(artifact.url);
        if (url.protocol !== "https:" || url.username || url.password) {
          throw new Error("Artifact URL must be credential-free HTTPS");
        }
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESULT_BYTES) {
    throw new Error("Adapter result is too large");
  }
}

/// The stored and attested form of a result: its JSON normalization (which
/// drops undefined members), refused when PostgreSQL jsonb or canonical
/// hashing could not represent it, so an admitted claim never strands on an
/// unstorable terminal write.
function persistableResult(result: ServiceResult): ServiceResult {
  const normalized = JSON.parse(JSON.stringify(result)) as ServiceResult;
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.includes("\u0000")) throw new Error("Adapter result contains U+0000");
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        visit(key);
        visit(child);
      }
    }
  };
  visit(normalized);
  canonicalHash(normalized);
  return normalized;
}

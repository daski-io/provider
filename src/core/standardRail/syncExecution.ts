import { logError } from "../logger.js";
import { SYNC_EXECUTION_BUDGET_SECONDS } from "../serviceRegistry/deadlines.js";
import type {
  FulfillmentAdapter,
  ServiceResult,
  TaskContext,
} from "../serviceRegistry/types.js";
import {
  failureEvidence,
  SERVICE_EXECUTION_FAILED,
  terminalServiceResult,
  type ResultContract,
} from "./serviceResult.js";

/** The synchronous mode's execution budget, not Daski's maximum service duration. */
export const MAX_EXECUTION_MS = SYNC_EXECUTION_BUDGET_SECONDS * 1_000;

/**
 * Run an admitted synchronous execution under the 50-second budget and
 * return the one result to freeze. A throw or timeout becomes the generic
 * failure; adapter text from a thrown error never reaches the buyer. A
 * completed result that fails the admitted result contract becomes the
 * reviewed `service_result_invalid` failure, because a synchronous task has
 * no later retrieval, and leaves a stable diagnostic in the log.
 */
export async function executeSynchronously(
  adapter: FulfillmentAdapter,
  context: Omit<TaskContext, "signal">,
  input: Record<string, unknown>,
  contract: ResultContract,
): Promise<ServiceResult> {
  let value: unknown;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MAX_EXECUTION_MS);
    timeout.unref();
    try {
      value = await Promise.race([
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
  } catch {
    return failureEvidence(SERVICE_EXECUTION_FAILED);
  }
  const terminal = terminalServiceResult(value, contract);
  if (terminal.diagnostic) {
    logError("Synchronous result failed its admitted result contract", {
      taskId: context.taskId,
      serviceSlug: context.serviceSlug,
      skillId: context.skillId,
      diagnostic: terminal.diagnostic.code,
      schemaKeywords: terminal.diagnostic.keywords,
    });
  }
  return terminal.result;
}

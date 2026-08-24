import type {
  AdapterResult,
  TaskContext,
} from "../../../core/serviceRegistry/types.js";
import { validateMessage } from "../validation.js";

/// Free skill: the minimal completed-immediately shape. Artifacts are the
/// buyer-visible output; `message` is the human-readable summary.
export async function executeEcho(
  _task: TaskContext,
  data: Record<string, unknown>,
): Promise<AdapterResult> {
  const invalid = validateMessage(data.message);
  if (invalid) {
    return { status: "failed", error: invalid.message };
  }
  return {
    status: "completed",
    message: "Echo completed.",
    artifacts: [
      {
        name: "echo_result",
        data: {
          message: data.message as string,
          processedAt: new Date().toISOString(),
        },
      },
    ],
  };
}

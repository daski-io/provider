import type {
  FulfillmentAdapter,
  ServiceResult,
  TaskContext,
} from "../../core/serviceRegistry/types.js";
import { DUMMY_SKILL_ID } from "./config.js";
import { parseMessage } from "./validation.js";

export class DummyAdapter implements FulfillmentAdapter {
  async execute(
    context: TaskContext,
    input: Record<string, unknown>,
  ): Promise<ServiceResult> {
    if (context.skillId !== DUMMY_SKILL_ID) {
      return { status: "failed", errorCode: "unknown_skill" };
    }
    try {
      const message = parseMessage(input.message);
      return {
        status: "completed",
        message: "Echo completed.",
        artifacts: [{
          name: "echo_result",
          mimeType: "application/json",
          data: { message },
        }],
      };
    } catch {
      return {
        status: "failed",
        errorCode: "invalid_input",
        message: "The message must contain 1 to 500 Unicode code points.",
      };
    }
  }
}

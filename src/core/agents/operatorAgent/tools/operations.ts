import { getOperationsSummary } from "../../../operations/summary.js";
import type { OperatorTool } from "./shared.js";

export const getOperationsSummaryTool: OperatorTool = {
  definition: {
    type: "function",
    function: {
      name: "get_operations_summary",
      description: "Get provider wallet, write, reputation-outcome, and durable-queue health.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async execute() {
    return JSON.stringify(await getOperationsSummary());
  },
};

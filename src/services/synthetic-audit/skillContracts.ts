import type { SkillContractDefinition } from "../../core/serviceRegistry/types.js";
import { inputContract, schema } from "../../core/serviceRegistry/types.js";
import { AUDIT_FULFILLMENT_SECONDS } from "./config.js";
import { MAX_DESCRIPTION_CODE_POINTS } from "./validation.js";

export const auditSkillContracts: Record<string, SkillContractDefinition> = {
  audit: {
    inputSchema: inputContract(["description"], [], {
      description: schema.string(MAX_DESCRIPTION_CODE_POINTS),
    }),
    // The whole completed ServiceResult the adapter maps a report to; the
    // lifecycle artifact read delivers exactly this object.
    resultSchema: schema.object({
      status: schema.stringEnum(["completed"]),
      message: schema.string(120),
      artifacts: schema.array(schema.object({
        name: schema.stringEnum(["audit_report"]),
        mimeType: schema.stringEnum(["application/json"]),
        data: schema.object({
          summary: schema.string(500),
          findings: schema.array(schema.object({
            severity: schema.stringEnum(["low", "medium", "high"]),
            title: schema.string(200),
          }, ["severity", "title"]), 50),
        }, ["summary", "findings"]),
      }, ["name", "mimeType", "data"]), 1, 1),
    }, ["status", "message", "artifacts"]),
    capacity: { maxOpenOrders: 10 },
    // The eight-hour audit, its queue, retries and report retrieval.
    deadlines: { dispatchSeconds: 300, fulfillmentSeconds: AUDIT_FULFILLMENT_SECONDS },
  },
};

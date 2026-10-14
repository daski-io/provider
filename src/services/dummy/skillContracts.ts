import type { SkillContractDefinition } from "../../core/serviceRegistry/types.js";
import { inputContract, schema } from "../../core/serviceRegistry/types.js";

export const dummySkillContracts: Record<string, SkillContractDefinition> = {
  echo: {
    inputSchema: inputContract(["message"], [], {
      message: schema.string(500),
    }),
    // The whole completed ServiceResult the adapter returns; the lifecycle
    // artifact read delivers exactly this object.
    resultSchema: schema.object({
      status: schema.stringEnum(["completed"]),
      message: schema.string(120),
      artifacts: schema.array(schema.object({
        name: schema.stringEnum(["echo_result"]),
        mimeType: schema.stringEnum(["application/json"]),
        data: schema.object({ message: schema.string(500) }, ["message"]),
      }, ["name", "mimeType", "data"]), 1, 1),
    }, ["status", "message", "artifacts"]),
    capacity: { maxOpenOrders: 10 },
    // Long enough for the gateway to recover a lost dispatch (see deadlines.ts).
    deadlines: { dispatchSeconds: 300, fulfillmentSeconds: 900 },
  },
};

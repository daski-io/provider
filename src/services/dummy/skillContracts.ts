import type { SkillContractDefinition } from "../../core/serviceRegistry/types.js";
import { inputContract, schema } from "../../core/serviceRegistry/types.js";

export const dummySkillContracts: Record<string, SkillContractDefinition> = {
  echo: {
    inputSchema: inputContract(["message"], [], {
      message: schema.string(500),
    }),
    resultSchema: schema.object({
      message: schema.string(500),
      processedAt: schema.string(64),
    }, ["message", "processedAt"]),
    capacity: { maxOpenOrders: 10 },
    deadlines: { dispatchSeconds: 300, fulfillmentSeconds: 50 },
  },
};

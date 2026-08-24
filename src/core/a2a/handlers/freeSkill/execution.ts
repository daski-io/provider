import type { AssetRow } from "../../../db/queries/assets.js";
import type { ServiceRow } from "../../../db/queries/services.js";
import type { SkillRow } from "../../../db/queries/skills.js";
import type { TransactionRow } from "../../../db/queries/transactions.js";
import {
  applyPreExecuteDecision,
  consultPreExecuteAgent,
} from "../../../engine/preExecuteRunner.js";
import {
  executeAdapter,
  processAdapterResult,
} from "../../../engine/taskManager.js";
import { fetchSubmissionResponse } from "../../responseBuilder.js";

export async function executeFreeSkill(args: {
  service: ServiceRow;
  skill: SkillRow;
  taskId: string;
  transaction: TransactionRow;
  data: Record<string, unknown>;
  asset?: AssetRow;
}) {
  const decision = await consultPreExecuteAgent(
    args.service,
    args.skill,
    args.data,
    false,
    args.taskId,
    args.asset ?? null,
  );
  const handled = await applyPreExecuteDecision({
    decision,
    transactionId: args.taskId,
    service: args.service,
    skill: args.skill,
    requestData: args.data,
    assetContext: args.asset ?? null,
  });
  if (handled.terminal) {
    return fetchSubmissionResponse(handled.task);
  }
  const result = await executeAdapter(
    args.service.slug,
    args.skill.skill_id,
    {
      id: args.taskId,
      service_id: args.service.id,
      skill_id: args.skill.skill_id,
      status: args.transaction.status,
    },
    args.data,
    args.asset,
  );
  const updated = await processAdapterResult(
    args.taskId,
    result,
    args.service.id,
  );
  return fetchSubmissionResponse(updated);
}

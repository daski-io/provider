import {
  ANONYMOUS_TASK_ACCESS_HASH_KEY,
  issueAnonymousTaskAccess,
  recoverAnonymousTaskAccess,
} from "../../anonymousTaskAccess.js";
import { createHash } from "node:crypto";
import type { AssetRow } from "../../../db/queries/assets.js";
import type { ServiceRow } from "../../../db/queries/services.js";
import {
  createOrGetEphemeralTransaction,
  createTransaction,
} from "../../../db/queries/transactions.js";
import { applyServiceRedaction } from "../../../engine/redaction.js";
import { generateTaskId } from "../../../engine/taskManager.js";
import { recordMandatoryAudit } from "../../../events/emitter.js";
import { inTransaction } from "../../../db/queryable.js";
import { pool } from "../../../db/pool.js";
import { config } from "../../../config.js";
import type { TaskDurability } from "../../../serviceRegistry/types.js";
import { computeRequestHash } from "../../../auth/requestHash.js";

export async function materializeFreeSkill(args: {
  service: ServiceRow;
  skillId: string;
  data: Record<string, unknown>;
  asset?: AssetRow;
  messageId: string;
  taskDurability: TaskDurability;
}) {
  return inTransaction(pool, async (db) => {
    const proposedTaskId = generateTaskId();
    const proposedAccess = issueAnonymousTaskAccess(proposedTaskId);
    const requestSummary = `Execute ${args.skillId}`;
    const metadata = {
      request_text: requestSummary,
      request_data: applyServiceRedaction(
        args.service.slug,
        args.skillId,
        args.data,
      ),
      ...(proposedAccess
        ? { [ANONYMOUS_TASK_ACCESS_HASH_KEY]: proposedAccess.hash }
        : {}),
    };
    const ephemeral = args.taskDurability === "ephemeral";
    const canonicalRequestHash = Buffer.from(
      computeRequestHash(args.data).slice(2),
      "hex",
    );
    const materialized = ephemeral
      ? await createOrGetEphemeralTransaction({
          id: proposedTaskId,
          customer_id: null,
          service_id: args.service.id,
          skill_id: args.skillId,
          status: "submitted",
          metadata,
          expires_at: new Date(
            Date.now() + config.ANONYMOUS_TASK_RETENTION_HOURS * 60 * 60 * 1_000,
          ),
          request_id_hash: createHash("sha256")
            .update(`${args.service.id}\0${args.skillId}\0${args.messageId}\0`, "utf8")
            .update(canonicalRequestHash)
            .digest(),
          canonical_request_hash: canonicalRequestHash,
        }, db)
      : {
          transaction: await createTransaction({
            id: proposedTaskId,
            customer_id: null,
            asset_id: args.asset?.id ?? null,
            service_id: args.service.id,
            skill_id: args.skillId,
            status: "submitted",
            metadata,
          }, db),
          created: true,
        };
    const taskId = materialized.transaction.id;
    const anonymousAccess = recoverAnonymousTaskAccess(taskId, materialized.transaction.metadata);
    if (!anonymousAccess) {
      throw new Error("anonymous task access key is unavailable");
    }
    if (materialized.created) {
      await recordMandatoryAudit(db, {
        transactionId: taskId,
        serviceId: args.service.id,
        source: "adapter",
        type: "transaction.message.user",
        message: requestSummary,
        payload: { role: "user", content: requestSummary },
      });
    }
    return {
      taskId,
      transaction: materialized.transaction,
      anonymousAccess,
      replayed: !materialized.created,
    };
  });
}

import type { Response } from "express";
import {
  appendAnonymousTaskAccess,
} from "../anonymousTaskAccess.js";
import {
  DASKI_ERR,
  JSON_RPC,
  jsonRpcError,
  jsonRpcInternalError,
  jsonRpcSuccess,
} from "../jsonrpc.js";
import { executeFreeSkill } from "./freeSkill/execution.js";
import { materializeFreeSkill } from "./freeSkill/materialize.js";
import { resolveFreeSkillRequest } from "./freeSkill/request.js";
import type { DaskiMetadata } from "./freeSkill/types.js";
import { fetchSubmissionResponse } from "../responseBuilder.js";
import { EphemeralRequestConflictError } from "../../db/queries/transactions.js";

export async function handleFreeSkill(
  message: Record<string, unknown>,
  metadata: DaskiMetadata,
  serviceSlug: string,
  res: Response,
  requestId: string | number | null,
): Promise<void> {
  const resolved = await resolveFreeSkillRequest({
    message,
    metadata,
    serviceSlug,
  });
  if (!resolved.ok) {
    return jsonRpcError(
      res,
      resolved.code,
      resolved.message,
      requestId,
      resolved.data,
    );
  }
  const { service, skill, skillId, data, messageId, taskDurability } = resolved;
  let materialized;
  try {
    materialized = await materializeFreeSkill({
      service,
      skillId,
      data,
      messageId,
      taskDurability,
    });
  } catch (error) {
    if (error instanceof EphemeralRequestConflictError) {
      return jsonRpcError(
        res,
        JSON_RPC.INVALID_PARAMS,
        "Request could not be admitted",
        requestId,
      );
    }
    throw error;
  }
  try {
    const response = materialized.replayed
      ? await fetchSubmissionResponse(materialized.transaction)
      : await executeFreeSkill({
          service,
          skill,
          taskId: materialized.taskId,
          transaction: materialized.transaction,
          data,
          asset: undefined,
        });
    return jsonRpcSuccess(
      res,
      requestId,
      materialized.anonymousAccess
        ? appendAnonymousTaskAccess(
            response,
            materialized.anonymousAccess.token,
          )
        : response,
    );
  } catch (error) {
    return jsonRpcInternalError(
      res,
      DASKI_ERR.FULFILLMENT_FAILED,
      "Fulfillment failed",
      error,
      requestId,
      { skillId, serviceSlug, transactionId: materialized.taskId },
      materialized.anonymousAccess
        ? {
            taskAccessToken: materialized.anonymousAccess.token,
            taskId: materialized.taskId,
          }
        : undefined,
    );
  }
}

import type { Response } from "express";
import { jsonRpcSuccess, jsonRpcError, JSON_RPC, A2A_ERR, DASKI_ERR } from "../jsonrpc.js";
import { fetchTaskResponse } from "../responseBuilder.js";
import { getServiceBySlug } from "../../db/queries/services.js";
import { getTransactionById } from "../../db/queries/transactions.js";
import { verifyAnonymousTaskAccess } from "../anonymousTaskAccess.js";

export async function handleTasksGet(
  params: Record<string, unknown>,
  serviceSlug: string,
  res: Response,
  requestId: string | number | null,
): Promise<void> {
  const taskId = params.id as string;
  if (!taskId) {
    return jsonRpcError(res, JSON_RPC.INVALID_REQUEST, "Missing task id", requestId);
  }

  const task = await getTransactionById(taskId);
  if (!task || task.standard_order_id) {
    return jsonRpcError(res, A2A_ERR.TASK_NOT_FOUND, `Task not found: ${taskId}`, requestId);
  }

  // Verify the transaction belongs to this service.
  const service = await getServiceBySlug(serviceSlug);
  if (!service || task.service_id !== service.id) {
    return jsonRpcError(res, DASKI_ERR.SERVICE_OWNERSHIP_MISMATCH, "Task does not belong to this service", requestId);
  }

  if (task.customer_id !== null || !verifyAnonymousTaskAccess(params.taskAccessToken, task.metadata)) {
    return jsonRpcError(
      res,
      DASKI_ERR.CAPABILITY_REQUIRED,
      "taskAccessToken required for this anonymous task",
      requestId,
    );
  }

  return jsonRpcSuccess(res, requestId, await fetchTaskResponse(task));
}

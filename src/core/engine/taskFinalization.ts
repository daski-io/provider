import { pool } from "../db/pool.js";
import {
  getTransactionById,
  mergeTransactionMetadata,
  type TransactionRow,
  type TransactionStatus,
} from "../db/queries/transactions.js";
import { inTransaction } from "../db/queryable.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import type { AdapterResult } from "../serviceRegistry/types.js";
import { storeAsset } from "./assetManager.js";
import { storeScreeningAssetProfile } from "../screening/registry.js";
import { taskEvents } from "./events.js";
import { canTransition } from "./stateMachine.js";
import {
  applyTaskTransition,
  type DeferredTaskEmits,
  type FailureClass,
} from "./taskTransitions.js";
import { enqueueReputationOutcome } from "../standardRail/reputationOutcomeStore.js";

async function persistDeliverables(
  taskId: string,
  serviceId: string,
  result: AdapterResult,
  db: Parameters<typeof recordMandatoryAudit>[0],
  deferred: DeferredTaskEmits,
): Promise<void> {
  for (const artifact of result.artifacts ?? []) {
    await recordMandatoryAudit(db, {
      transactionId: taskId,
      serviceId,
      source: "adapter",
      type: "transaction.artifact.created",
      message: `Artifact: ${artifact.name}`,
      payload: {
        name: artifact.name,
        mime_type: artifact.mimeType ?? "application/json",
        url: artifact.url,
        data: artifact.data,
        access_action: artifact.accessAction,
      },
    });
    deferred.push(() =>
      taskEvents.emitTaskEvent({
        type: "artifact",
        taskId,
        artifactName: artifact.name,
      })
    );
  }
  if (result.asset) {
    const asset = await storeAsset({
      transactionId: taskId,
      serviceId,
      type: result.asset.assetType,
      identifier: result.asset.assetIdentifier,
      metadata: result.asset.assetData,
      expiresAt: result.asset.expiresAt,
    }, db);
    if (result.asset.screeningSubjects?.length) {
      const service = await db.query<{ slug: string }>(
        "SELECT slug FROM services WHERE id = $1",
        [serviceId],
      );
      const serviceSlug = service.rows[0]?.slug;
      if (!serviceSlug) throw new Error("Asset service is unavailable during screening-profile commit");
      await storeScreeningAssetProfile({
        asset,
        serviceSlug,
        subjects: result.asset.screeningSubjects,
        db,
      });
    }
  }
}

export async function processAdapterResult(
  taskId: string,
  result: AdapterResult,
  serviceId: string,
): Promise<TransactionRow> {
  const deferred: DeferredTaskEmits = [];
  const task = await inTransaction(pool, async (db) => {
    let current = await getTransactionById(taskId, db);
    if (!current) throw new Error(`Transaction not found: ${taskId}`);
    if (
      current.status !== result.status
      && !canTransition(current.status, result.status)
      && canTransition(current.status, "working")
      && canTransition("working", result.status)
    ) {
      current = await applyTaskTransition(db, current, "working", {}, deferred);
    }
    await persistDeliverables(taskId, serviceId, result, db, deferred);
    if (result.status === "failed" && result.autoRefundContext) {
      await mergeTransactionMetadata(taskId, {
        auto_refund_class: result.autoRefundContext.class,
        failure_supplier: result.autoRefundContext.supplier,
        failure_kind: result.autoRefundContext.kind,
        failure_attempts: result.autoRefundContext.attempts,
      }, db);
    }
    if (current.status === result.status) {
      if (result.message && result.status === "working") {
        await recordMandatoryAudit(db, {
          transactionId: taskId,
          serviceId,
          source: "adapter",
          type: "transaction.message.agent",
          message: result.message,
          payload: { role: "agent", content: result.message },
        });
      }
      await enqueueReputationOutcome(current, db);
      return current;
    }
    const failureClass: FailureClass | null =
      result.status === "failed" ? result.failureClass ?? "terminal" : null;
    const transitioned = await applyTaskTransition(
      db,
      current,
      result.status as TransactionStatus,
      { message: result.message, failureClass },
      deferred,
    );
    await enqueueReputationOutcome(transitioned, db);
    return transitioned;
  });
  for (const emit of deferred) emit();
  return task;
}

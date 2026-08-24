import { pool } from "../db/pool.js";
import { upsertCustomer } from "../db/queries/customers.js";
import { decryptString, encryptString } from "../chain/encryption.js";
import type { Address, Hex } from "viem";
import type { ProviderWalletConfig } from "./walletConfig.js";
import { consumeAssetEndpointRate } from "./assetRateLimit.js";
import type { DeferredTaskEmits } from "../engine/taskTransitions.js";
import { cancelLinkedAssetActionTransaction } from "./actionLifecycle.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const hex = (value: Buffer): Hex => `0x${value.toString("hex")}`;

export interface AssetActionExecutionRow {
  execution_id: Buffer;
  payer: string;
  provider_asset_id: string;
  action_hash: Buffer;
  request_hash: Buffer;
  wallet_authorization_hash: Buffer;
  grant_hash: Buffer;
  provider_control_profile_hash: Buffer;
  servicing_admission_hash: Buffer;
  action_catalog_hash: Buffer;
  action_catalog_schema_hash: Buffer;
  action_catalog_epoch: string;
  action_definition_hash: Buffer;
  replay_policy: "stable-result" | "regenerate-ephemeral" | "redacted-after-window";
  state: "claimed" | "staged" | "executing" | "completed" | "failed" | "canceled" | "expired" | "attention";
  effect_summary: Record<string, unknown> | null;
  confirmation_hash: Buffer | null;
  earliest_execution_at: Date | null;
  stage_valid_before: Date | null;
  result_valid_before: Date;
  result_redacted_at: Date | null;
  sanitized_result: Record<string, unknown> | null;
  error_class: string | null;
}

interface ClaimArgs {
  executionId: Hex;
  payer: Hex;
  providerAssetId: string;
  serviceId: string;
  skillId: string;
  actionId: string;
  actionHash: Hex;
  requestHash: Hex;
  walletAuthorizationHash: Hex;
  walletNonce: Hex;
  grantHash: Hex;
  grantNonce: Hex;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  actionCatalogHash: Hex;
  actionCatalogSchemaHash: Hex;
  actionCatalogEpoch: number;
  actionDefinitionHash: Hex;
  replayPolicy: "stable-result" | "regenerate-ephemeral" | "redacted-after-window";
  resultValidBefore: number;
  gatewaySigner: Address;
  abuse: ProviderWalletConfig["abuse"];
  destructive?: {
    input: Record<string, unknown>;
    effectSummary: Record<string, unknown>;
    confirmationHash: Hex;
    earliestExecutionAt: number;
    stageValidBefore: number;
  };
}

const payloadContext = (executionId: Hex) => ({
  purpose: "destructive-asset-action",
  table: "standard_destructive_action_payloads",
  recordId: executionId,
  field: "encrypted_input",
  recordVersion: 1,
} as const);

const recoveryResultContext = (row: AssetActionExecutionRow) => ({
  purpose: "asset-action-recovery-result",
  table: "standard_asset_action_recovery_results",
  recordId: `${hex(row.execution_id)}:${row.payer}:${row.provider_asset_id}:${hex(row.action_hash)}`,
  field: "encrypted_result",
  recordVersion: 1,
} as const);

export async function claimAssetAction(args: ClaimArgs): Promise<{
  row: AssetActionExecutionRow;
  taskId: string;
  replayed: boolean;
}> {
  const client = await pool.connect();
  const taskId = `asset-action-${args.executionId.slice(2)}`;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [taskId]);
    await consumeAssetEndpointRate({
      db: client, gatewaySigner: args.gatewaySigner, payer: args.payer,
      actionId: args.actionId, limits: args.abuse,
    });
    const prior = await client.query<AssetActionExecutionRow>(
      "SELECT * FROM standard_asset_action_executions WHERE execution_id=$1",
      [bytes(args.executionId)],
    );
    const existing = prior.rows[0];
    if (existing) {
      if (
        existing.payer.toLowerCase() !== args.payer.toLowerCase() ||
        existing.provider_asset_id !== args.providerAssetId ||
        hex(existing.action_hash) !== args.actionHash || hex(existing.request_hash) !== args.requestHash ||
        hex(existing.wallet_authorization_hash) !== args.walletAuthorizationHash ||
        hex(existing.provider_control_profile_hash) !== args.providerControlProfileHash ||
        hex(existing.servicing_admission_hash) !== args.servicingAdmissionHash ||
        hex(existing.action_catalog_hash) !== args.actionCatalogHash ||
        hex(existing.action_catalog_schema_hash) !== args.actionCatalogSchemaHash ||
        Number(existing.action_catalog_epoch) !== args.actionCatalogEpoch ||
        hex(existing.action_definition_hash) !== args.actionDefinitionHash ||
        existing.replay_policy !== args.replayPolicy
      ) throw new Error("asset action replay mismatch");
      await consumeGrant(client, args.grantNonce, args.grantHash, args.payer);
      await client.query("COMMIT");
      return { row: existing, taskId, replayed: true };
    }
    if (args.destructive) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "provider:destructive-stage-cap",
      ]);
      const outstanding = await client.query<{ payer_count: string; provider_count: string }>(
        `SELECT count(*) FILTER (WHERE lower(payer)=lower($1))::text AS payer_count,
                count(*)::text AS provider_count
           FROM standard_asset_action_executions
          WHERE state='staged' AND stage_valid_before>now()`,
        [args.payer],
      );
      const counts = outstanding.rows[0]!;
      if (
        Number(counts.payer_count) >= args.abuse.destructiveOutstandingPerPayer ||
        Number(counts.provider_count) >= args.abuse.destructiveOutstandingPerProvider ||
        Number(counts.provider_count) >= args.abuse.destructiveOutstandingGlobal
      ) throw new Error("destructive action capacity exceeded");
    }
    const customer = await upsertCustomer(args.payer, client);
    await client.query(
      `INSERT INTO standard_wallet_action_nonces
        (payer,nonce,action_hash,request_hash,wallet_authorization_hash)
       VALUES ($1,$2,$3,$4,$5)`,
      [args.payer, bytes(args.walletNonce), bytes(args.actionHash), bytes(args.requestHash),
        bytes(args.walletAuthorizationHash)],
    );
    await consumeGrant(client, args.grantNonce, args.grantHash, args.payer);
    await client.query(
      `INSERT INTO transactions
        (id,customer_id,asset_id,service_id,skill_id,status,metadata,canonical_request_hash,
         standard_payer,standard_action_execution_id)
       VALUES ($1,$2,$3,$4,$5,'working','{}'::jsonb,$6,$7,$8)`,
      [taskId, customer.id, args.providerAssetId, args.serviceId, args.skillId,
        bytes(args.requestHash), args.payer, bytes(args.executionId)],
    );
    const inserted = await client.query<AssetActionExecutionRow>(
      `INSERT INTO standard_asset_action_executions
        (execution_id,payer,provider_asset_id,action_hash,request_hash,wallet_authorization_hash,
         grant_hash,provider_control_profile_hash,servicing_admission_hash,action_catalog_hash,
         action_catalog_schema_hash,action_catalog_epoch,action_definition_hash,state,effect_summary,
         replay_policy,confirmation_hash,earliest_execution_at,stage_valid_before,result_valid_before)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               to_timestamp($18::double precision),to_timestamp($19::double precision),
               to_timestamp($20::double precision))
       RETURNING *`,
      [bytes(args.executionId), args.payer, args.providerAssetId, bytes(args.actionHash),
        bytes(args.requestHash), bytes(args.walletAuthorizationHash), bytes(args.grantHash),
        bytes(args.providerControlProfileHash), bytes(args.servicingAdmissionHash),
        bytes(args.actionCatalogHash), bytes(args.actionCatalogSchemaHash), args.actionCatalogEpoch,
        bytes(args.actionDefinitionHash), args.destructive ? "staged" : "claimed",
        args.destructive?.effectSummary ?? null,
        args.replayPolicy,
        args.destructive ? bytes(args.destructive.confirmationHash) : null,
        args.destructive?.earliestExecutionAt ?? null, args.destructive?.stageValidBefore ?? null,
        args.resultValidBefore],
    );
    if (args.destructive) {
      await client.query(
        `INSERT INTO standard_destructive_action_payloads(execution_id,encrypted_input,expires_at)
         VALUES ($1,$2,to_timestamp($3))`,
        [bytes(args.executionId), encryptString(
          JSON.stringify(args.destructive.input), payloadContext(args.executionId),
        ), args.destructive.stageValidBefore],
      );
    }
    await client.query("COMMIT");
    return { row: inserted.rows[0]!, taskId, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function consumeGrant(
  db: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  nonce: Hex,
  grantHash: Hex,
  payer: Hex,
): Promise<void> {
  await db.query(
    `INSERT INTO standard_provider_grant_nonces(grant_nonce,grant_hash,payer)
     VALUES ($1,$2,$3)`,
    [bytes(nonce), bytes(grantHash), payer],
  );
}

export async function loadDestructiveInput(executionId: Hex): Promise<Record<string, unknown>> {
  const result = await pool.query<{ encrypted_input: string; expires_at: Date }>(
    "SELECT encrypted_input,expires_at FROM standard_destructive_action_payloads WHERE execution_id=$1",
    [bytes(executionId)],
  );
  const row = result.rows[0];
  if (!row || row.expires_at <= new Date()) throw new Error("staged action expired");
  const parsed: unknown = JSON.parse(decryptString(row.encrypted_input, payloadContext(executionId)));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("staged input invalid");
  return parsed as Record<string, unknown>;
}

export async function authorizeStagedAction(args: {
  followupExecutionId: Hex;
  executionId: Hex;
  payer: Hex;
  confirmationHash: Hex;
  operation: "confirm" | "cancel";
  actionId: string;
  actionHash: Hex;
  requestHash: Hex;
  walletAuthorizationHash: Hex;
  walletNonce: Hex;
  grantHash: Hex;
  grantNonce: Hex;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  actionCatalogHash: Hex;
  actionCatalogSchemaHash: Hex;
  actionCatalogEpoch: number;
  actionDefinitionHash: Hex;
  gatewaySigner: Address;
  abuse: ProviderWalletConfig["abuse"];
}): Promise<{ row: AssetActionExecutionRow; taskId: string; replayed: boolean }> {
  const client = await pool.connect();
  const taskId = `asset-action-${args.executionId.slice(2)}`;
  const deferred: DeferredTaskEmits = [];
  let result: { row: AssetActionExecutionRow; taskId: string; replayed: boolean } | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [taskId]);
    await consumeAssetEndpointRate({
      db: client, gatewaySigner: args.gatewaySigner, payer: args.payer,
      actionId: args.actionId, limits: args.abuse,
    });
    const found = await client.query<AssetActionExecutionRow>(
      "SELECT * FROM standard_asset_action_executions WHERE execution_id=$1 FOR UPDATE",
      [bytes(args.executionId)],
    );
    const row = found.rows[0];
    const prior = await client.query<{
      action_execution_id: Buffer;
      payer: string;
      operation: "confirm" | "cancel";
      confirmation_hash: Buffer;
      wallet_authorization_hash: Buffer;
      request_hash: Buffer;
    }>(
      `SELECT * FROM standard_destructive_followup_executions
        WHERE followup_execution_id=$1 FOR UPDATE`,
      [bytes(args.followupExecutionId)],
    );
    const existing = prior.rows[0];
    if (existing && (
      hex(existing.action_execution_id) !== args.executionId ||
      existing.payer.toLowerCase() !== args.payer.toLowerCase() ||
      existing.operation !== args.operation ||
      hex(existing.confirmation_hash) !== args.confirmationHash ||
      hex(existing.wallet_authorization_hash) !== args.walletAuthorizationHash ||
      hex(existing.request_hash) !== args.requestHash
    )) throw new Error("staged action replay mismatch");
    if (
      !row || row.payer.toLowerCase() !== args.payer.toLowerCase() ||
      hex(row.provider_control_profile_hash) !== args.providerControlProfileHash ||
      hex(row.servicing_admission_hash) !== args.servicingAdmissionHash ||
      hex(row.action_catalog_hash) !== args.actionCatalogHash ||
      hex(row.action_catalog_schema_hash) !== args.actionCatalogSchemaHash ||
      Number(row.action_catalog_epoch) !== args.actionCatalogEpoch ||
      hex(row.action_definition_hash) !== args.actionDefinitionHash ||
      !row.confirmation_hash || hex(row.confirmation_hash) !== args.confirmationHash ||
      (!existing && (!row.stage_valid_before || row.stage_valid_before <= new Date())) ||
      (!existing && args.operation === "confirm" &&
        (!row.earliest_execution_at || row.earliest_execution_at > new Date())) ||
      (!existing && row.state !== "staged") ||
      (existing && args.operation === "confirm" &&
        !["executing", "completed", "failed", "attention"].includes(row.state)) ||
      (existing && args.operation === "cancel" && row.state !== "canceled")
    ) throw new Error("staged action unavailable");
    if (!existing) {
      await client.query(
        `INSERT INTO standard_wallet_action_nonces
          (payer,nonce,action_hash,request_hash,wallet_authorization_hash)
         VALUES ($1,$2,$3,$4,$5)`,
        [args.payer, bytes(args.walletNonce), bytes(args.actionHash), bytes(args.requestHash),
          bytes(args.walletAuthorizationHash)],
      );
      await client.query(
        `INSERT INTO standard_destructive_followup_executions
          (followup_execution_id,action_execution_id,payer,operation,confirmation_hash,
           wallet_authorization_hash,request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [bytes(args.followupExecutionId), bytes(args.executionId), args.payer, args.operation,
          bytes(args.confirmationHash), bytes(args.walletAuthorizationHash), bytes(args.requestHash)],
      );
    }
    await consumeGrant(client, args.grantNonce, args.grantHash, args.payer);
    if (!existing) {
      row.state = args.operation === "confirm" ? "executing" : "canceled";
      await client.query(
        `UPDATE standard_asset_action_executions SET state=$2,
            reconciliation_identity=CASE WHEN $2='executing' THEN COALESCE(reconciliation_identity,$3)
              ELSE reconciliation_identity END,updated_at=now() WHERE execution_id=$1`,
        [bytes(args.executionId), row.state, taskId],
      );
      if (row.state === "canceled") {
        await client.query("DELETE FROM standard_destructive_action_payloads WHERE execution_id=$1", [
          bytes(args.executionId),
        ]);
      }
      if (row.state === "executing") {
        await client.query(
          "UPDATE standard_destructive_action_payloads SET expires_at=$2 WHERE execution_id=$1",
          [bytes(args.executionId), row.result_valid_before],
        );
      }
    }
    if (row.state === "canceled") {
      await cancelLinkedAssetActionTransaction({
        db: client,
        taskId,
        reason: "wallet_canceled",
        deferred,
      });
    }
    await client.query("COMMIT");
    result = { row, taskId, replayed: existing !== undefined };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  for (const emit of deferred) emit();
  return result!;
}

export async function transitionAssetAction(
  executionId: Hex,
  from: AssetActionExecutionRow["state"],
  to: AssetActionExecutionRow["state"],
  reconciliationIdentity?: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE standard_asset_action_executions SET state=$3,
        reconciliation_identity=COALESCE(reconciliation_identity,$4),updated_at=now()
      WHERE execution_id=$1 AND state=$2`,
    [bytes(executionId), from, to, reconciliationIdentity ?? null],
  );
  if (["completed", "failed", "canceled", "expired"].includes(to)) {
    await pool.query("DELETE FROM standard_destructive_action_payloads WHERE execution_id=$1", [bytes(executionId)]);
  }
  return result.rowCount === 1;
}

export async function loadAssetActionExecution(executionId: Hex): Promise<AssetActionExecutionRow> {
  const result = await pool.query<AssetActionExecutionRow>(
    "SELECT * FROM standard_asset_action_executions WHERE execution_id=$1",
    [bytes(executionId)],
  );
  if (!result.rows[0]) throw new Error("asset action unavailable");
  return result.rows[0];
}

export async function loadAssetActionForTask(taskId: string): Promise<AssetActionExecutionRow | null> {
  const result = await pool.query<AssetActionExecutionRow>(
    `SELECT e.* FROM standard_asset_action_executions e
       JOIN transactions t ON t.standard_action_execution_id=e.execution_id
      WHERE t.id=$1`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

export async function loadAssetActionStatesForTasks(
  taskIds: string[],
): Promise<Map<string, AssetActionExecutionRow["state"]>> {
  if (taskIds.length === 0) return new Map();
  const result = await pool.query<{ task_id: string; state: AssetActionExecutionRow["state"] }>(
    `SELECT t.id AS task_id,e.state
       FROM transactions t
       JOIN standard_asset_action_executions e
         ON e.execution_id=t.standard_action_execution_id
      WHERE t.id=ANY($1::text[])`,
    [taskIds],
  );
  return new Map(result.rows.map((row) => [row.task_id, row.state]));
}

export async function markAssetActionAttention(executionId: Hex): Promise<void> {
  const result = await pool.query(
    `UPDATE standard_asset_action_executions SET state='attention',updated_at=now()
      WHERE execution_id=$1 AND state IN ('claimed','executing','attention')`,
    [bytes(executionId)],
  );
  if (result.rowCount !== 1) throw new Error("asset action attention transition lost its claim");
}

export async function completeAssetAction(args: {
  executionId: Hex;
  status: "completed" | "failed";
  result: Record<string, unknown> | null;
  errorClass: string | null;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<AssetActionExecutionRow>(
      `SELECT * FROM standard_asset_action_executions
        WHERE execution_id=$1 AND state IN ('claimed','executing','attention') FOR UPDATE`,
      [bytes(args.executionId)],
    );
    const row = found.rows[0];
    if (!row) throw new Error("asset action completion lost its claim");
    if (args.status === "completed" && row.replay_policy !== "regenerate-ephemeral") {
      if (!args.result) throw new Error("recoverable action result is missing");
      await client.query(
        `INSERT INTO standard_asset_action_recovery_results(execution_id,encrypted_result,expires_at)
         VALUES ($1,$2,$3)`,
        [bytes(args.executionId), encryptString(JSON.stringify(args.result), recoveryResultContext(row)),
          row.result_valid_before],
      );
    }
    const updated = await client.query(
      `UPDATE standard_asset_action_executions
          SET state=$2,sanitized_result=NULL,error_class=$3,updated_at=now()
        WHERE execution_id=$1 AND state IN ('claimed','executing','attention')`,
      [bytes(args.executionId), args.status, args.errorClass],
    );
    if (updated.rowCount !== 1) throw new Error("asset action completion lost its claim");
    await client.query("DELETE FROM standard_destructive_action_payloads WHERE execution_id=$1", [
      bytes(args.executionId),
    ]);
    if (args.status === "completed" && row.replay_policy === "redacted-after-window") {
      await client.query("DELETE FROM artifact_secrets WHERE transaction_id=$1", [
        `asset-action-${args.executionId.slice(2)}`,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function loadAssetActionRecoveryResult(
  row: AssetActionExecutionRow,
): Promise<Record<string, unknown>> {
  if (row.result_valid_before <= new Date()) throw new Error("asset action recovery expired");
  const result = await pool.query<{ encrypted_result: string; expires_at: Date }>(
    `SELECT encrypted_result,expires_at FROM standard_asset_action_recovery_results
      WHERE execution_id=$1`,
    [row.execution_id],
  );
  const recovery = result.rows[0];
  if (!recovery || recovery.expires_at <= new Date()) throw new Error("asset action recovery unavailable");
  const parsed: unknown = JSON.parse(decryptString(recovery.encrypted_result, recoveryResultContext(row)));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("asset action recovery result invalid");
  }
  return parsed as Record<string, unknown>;
}

export async function expireDestructiveAssetActions(): Promise<{
  expired: number;
  attention: number;
}> {
  const client = await pool.connect();
  const deferred: DeferredTaskEmits = [];
  let result: { expired: number; attention: number } | undefined;
  try {
    await client.query("BEGIN");
    const expired = await client.query<{ execution_id: Buffer }>(
      `UPDATE standard_asset_action_executions SET state='expired',updated_at=now()
        WHERE state='staged' AND stage_valid_before<=now() RETURNING execution_id`,
    );
    const attention = await client.query<{ execution_id: Buffer }>(
      `UPDATE standard_asset_action_executions SET state='attention',updated_at=now(),
          error_class=NULL,sanitized_result=NULL
        WHERE state='executing' AND result_valid_before<=now() RETURNING execution_id`,
    );
    await client.query(
      `UPDATE standard_asset_action_executions
          SET sanitized_result=NULL,result_redacted_at=COALESCE(result_redacted_at,now()),updated_at=now()
        WHERE state='completed' AND result_redacted_at IS NULL AND result_valid_before<=now()`,
    );
    await client.query(
      "DELETE FROM standard_asset_action_recovery_results WHERE expires_at<=now()",
    );
    await client.query(
      "DELETE FROM standard_wallet_action_nonces WHERE consumed_at<now()-interval '10 minutes'",
    );
    await client.query(
      "DELETE FROM standard_provider_grant_nonces WHERE consumed_at<now()-interval '10 minutes'",
    );
    await client.query(
      "DELETE FROM standard_asset_rate_buckets WHERE window_started_at<now()-interval '2 minutes'",
    );
    const ids = [...expired.rows, ...attention.rows].map((row) => row.execution_id);
    for (const row of expired.rows) {
      await cancelLinkedAssetActionTransaction({
        db: client,
        taskId: `asset-action-${row.execution_id.toString("hex")}`,
        reason: "confirmation_expired",
        deferred,
      });
    }
    if (ids.length > 0) {
      await client.query(
        "DELETE FROM standard_destructive_action_payloads WHERE execution_id=ANY($1::bytea[])",
        [ids],
      );
    }
    await client.query("COMMIT");
    result = { expired: expired.rowCount ?? 0, attention: attention.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
  for (const emit of deferred) emit();
  return result!;
}

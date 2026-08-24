import {
  getTransactionById,
  listTransactions,
  type TransactionRow,
} from "../../../db/queries/transactions.js";
import { listEvents } from "../../../events/emitter.js";
import {
  loadAssetActionStatesForTasks,
  type AssetActionExecutionRow,
} from "../../../standardRail/actionStore.js";
import { type OperatorTool, summarizeTransaction } from "./shared.js";

function operationalTransaction(
  t: TransactionRow,
  assetActionState: AssetActionExecutionRow["state"] | null,
) {
  return {
    id: t.id,
    service_id: t.service_id,
    skill_id: t.skill_id,
    status: t.status,
    asset_id: t.asset_id,
    created_at: t.created_at.toISOString(),
    updated_at: t.updated_at.toISOString(),
    completed_at: t.completed_at?.toISOString() ?? null,
    customer_id: t.customer_id,
    payer: t.standard_payer ?? null,
    standard_order_id: t.standard_order_id ?? null,
    asset_action_state: assetActionState,
    status_detail: t.status === "working" && assetActionState === "staged"
      ? "awaiting-confirmation"
      : null,
  };
}

export const listTransactionsTool: OperatorTool = {
  definition: {
    type: "function",
    function: {
      name: "list_transactions",
      description:
        "List recent transactions, optionally filtered, including asset-action substates. Use this when the operator asks about transactions, activity, status counts. Returns up to 25 by default.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["submitted", "working", "input-required", "completed", "failed", "canceled"],
            description: "Optional A2A status filter.",
          },
          since_iso: {
            type: "string",
            description: "Optional ISO-8601 datetime; only return transactions created on or after this.",
          },
          limit: { type: "integer", description: "Max rows; default 25." },
        },
      },
    },
  },
  async execute(args) {
    const requestedLimit = typeof args.limit === "number" && Number.isInteger(args.limit)
      ? args.limit
      : 25;
    const since = typeof args.since_iso === "string" ? new Date(args.since_iso) : undefined;
    const txs = await listTransactions({
      status: args.status as TransactionRow["status"] | undefined,
      since: since && Number.isFinite(since.getTime()) ? since : undefined,
      limit: Math.max(1, Math.min(requestedLimit, 50)),
    });
    const actionStates = await loadAssetActionStatesForTasks(txs.map((tx) => tx.id));
    return JSON.stringify({
      count: txs.length,
      transactions: txs.map((tx) => operationalTransaction(tx, actionStates.get(tx.id) ?? null)),
    });
  },
};

export const getTransactionTool: OperatorTool = {
  definition: {
    type: "function",
    function: {
      name: "get_transaction",
      description:
        "Get a transaction's standard-order operational state, asset-action substate, and recent event types. Protected contact, request, and message content stays in the human UI.",
      parameters: {
        type: "object",
        properties: {
          transaction_id: { type: "string", description: "The transaction id." },
        },
        required: ["transaction_id"],
      },
    },
  },
  async execute(args) {
    const id = String(args.transaction_id ?? "");
    const tx = await getTransactionById(id);
    if (!tx) return JSON.stringify({ found: false });
    const events = await listEvents({ transactionId: id, limit: 30 });
    const actionStates = await loadAssetActionStatesForTasks([id]);
    return JSON.stringify({
      found: true,
      transaction: { ...operationalTransaction(tx, actionStates.get(id) ?? null), summary: summarizeTransaction(tx) },
      recent_events: events.slice(0, 15).map((e) => ({
        type: e.type,
        severity: e.severity,
        created_at: e.created_at.toISOString(),
      })),
    });
  },
};

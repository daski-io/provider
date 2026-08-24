import { pool } from "../pool.js";
import { randomUUID } from "node:crypto";
import { decryptString, encryptString } from "../../chain/encryption.js";
import type { Queryable } from "../queryable.js";

// Operator chat history, scoped by thread (chat_threads). Replayed back to
// the LLM on each turn (sliding window). System prompt is static and lives
// in code; only operator/agent/tool messages are persisted here. Agent
// rows may carry `suggested_actions` (quick-action buttons rendered under
// the message in the admin chat UI).

export type OperatorChatRole = "operator" | "agent" | "tool";

export interface OperatorChatRow {
  id: string;
  wallet_address: string;
  thread_id: string | null;
  role: OperatorChatRole;
  content: string;
  tool_calls: unknown;
  tool_call_id: string | null;
  suggested_actions: unknown;
  created_at: Date;
}

function chatContext(id: string, field: "content" | "tool_calls" | "suggested_actions") {
  return {
    purpose: "operator-context",
    table: "operator_chats",
    recordId: id,
    field,
  } as const;
}

function decryptChatRow(row: OperatorChatRow): OperatorChatRow {
  const decryptJson = (value: unknown, field: "tool_calls" | "suggested_actions") => {
    if (typeof value !== "string") return value;
    return JSON.parse(decryptString(value, chatContext(row.id, field)));
  };
  return {
    ...row,
    content: decryptString(row.content, chatContext(row.id, "content")),
    tool_calls: decryptJson(row.tool_calls, "tool_calls"),
    suggested_actions: decryptJson(row.suggested_actions, "suggested_actions"),
  };
}

export async function appendOperatorChatMessage(args: {
  threadId: string;
  walletAddress: string;
  role: OperatorChatRole;
  content: string;
  toolCalls?: unknown;
  toolCallId?: string | null;
  suggestedActions?: unknown;
}, db: Queryable = pool): Promise<OperatorChatRow> {
  const id = randomUUID();
  const result = await db.query(
    `INSERT INTO operator_chats
       (id, wallet_address, thread_id, role, content, tool_calls, tool_call_id, suggested_actions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      args.walletAddress.toLowerCase(),
      args.threadId,
      args.role,
      encryptString(args.content, chatContext(id, "content")),
      args.toolCalls
        ? JSON.stringify(encryptString(JSON.stringify(args.toolCalls), chatContext(id, "tool_calls")))
        : null,
      args.toolCallId ?? null,
      args.suggestedActions
        ? JSON.stringify(encryptString(JSON.stringify(args.suggestedActions), chatContext(id, "suggested_actions")))
        : null,
    ],
  );
  return decryptChatRow(result.rows[0] as OperatorChatRow);
}

/// Thread-scoped history, oldest-first (sliding window of the most recent
/// `limit` rows). Drives both the LLM replay and the admin chat render.
export async function listChatThreadMessages(
  threadId: string,
  limit = 50,
): Promise<OperatorChatRow[]> {
  const result = await pool.query(
    `SELECT * FROM operator_chats
      WHERE thread_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [threadId, limit],
  );
  return (result.rows as OperatorChatRow[]).map(decryptChatRow).reverse();
}

export async function clearChatThreadMessages(threadId: string): Promise<void> {
  await pool.query(`DELETE FROM operator_chats WHERE thread_id = $1`, [threadId]);
}

/// Batched, thread-grouped history for many threads at once — one query for
/// the whole set instead of N. Used by the Operator chat to render every
/// escalation's conversation inline (folded) without an N+1. Each thread is
/// capped to its most recent `perThreadLimit` messages, oldest-first.
export async function listMessagesForThreads(
  threadIds: string[],
  perThreadLimit = 100,
): Promise<Map<string, OperatorChatRow[]>> {
  const grouped = new Map<string, OperatorChatRow[]>();
  if (threadIds.length === 0) return grouped;
  const requestedLimit = Number.isFinite(perThreadLimit)
    ? Math.floor(perThreadLimit)
    : 100;
  const limit = Math.min(200, Math.max(1, requestedLimit));
  const result = await pool.query(
    `WITH ranked AS (
       SELECT oc.*,
              ROW_NUMBER() OVER (
                PARTITION BY thread_id
                ORDER BY created_at DESC, id DESC
              ) AS thread_rank
         FROM operator_chats oc
        WHERE thread_id = ANY($1)
     )
     SELECT id, wallet_address, thread_id, role, content, tool_calls,
            tool_call_id, suggested_actions, created_at
       FROM ranked
      WHERE thread_rank <= $2
      ORDER BY thread_id, created_at ASC, id ASC`,
    [threadIds, limit],
  );
  for (const stored of result.rows as OperatorChatRow[]) {
    const row = decryptChatRow(stored);
    const key = row.thread_id as string;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  return grouped;
}

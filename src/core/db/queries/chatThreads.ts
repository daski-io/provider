import { pool } from "../pool.js";
import { randomUUID } from "node:crypto";
import { decryptString, encryptString } from "../../chain/encryption.js";
import { revealEscalationText } from "../../security/escalationProtection.js";
import type {
  ReviewAction,
  ReviewSeverity,
} from "./escalations.js";
import type { Queryable } from "../queryable.js";

function titleContext(id: string) {
  return {
    purpose: "operator-chat-thread",
    table: "chat_threads",
    recordId: id,
    field: "title",
    service: "core",
  } as const;
}

function revealThread(row: ChatThreadRow): ChatThreadRow {
  return {
    ...row,
    title: row.title ? decryptString(row.title, titleContext(row.id)) : null,
  };
}

// Chat threads. Two kinds:
//   - Free-form operator chat: one per wallet, escalation_id IS NULL.
//   - Escalation thread: bound to one escalation, escalation_id = <id>.
// Messages live in operator_chats keyed by thread_id; the Operator Agent
// replays a thread's history on each turn.

export type ChatThreadStatus = "open" | "resolved" | "rejected";

export interface ChatThreadRow {
  id: string;
  wallet_address: string | null;
  escalation_id: string | null;
  title: string | null;
  status: ChatThreadStatus;
  created_at: Date;
  updated_at: Date;
}

export async function getChatThreadById(id: string): Promise<ChatThreadRow | null> {
  const result = await pool.query(`SELECT * FROM chat_threads WHERE id = $1`, [id]);
  const row = result.rows[0] as ChatThreadRow | undefined;
  return row ? revealThread(row) : null;
}

export interface EscalationThreadItem {
  thread_id: string | null;
  escalation_id: string;
  status: string;
  question: string;
  transaction_id: string | null;
  review_kind: string | null;
  severity: ReviewSeverity;
  target_type: string | null;
  target_id: string | null;
  why_human: string | null;
  evidence: Record<string, unknown>;
  available_actions: ReviewAction[];
  review_due_at: Date | null;
  occurrence_count: number;
  last_seen_at: Date;
  total_count: number;
  created_at: Date;
}

export interface ReviewQueueFilters {
  lifecycle: "open" | "closed" | "all";
  kind?: string | null;
  severity?: ReviewSeverity | null;
  limit: number;
  offset: number;
}

export async function listEscalationThreads(
  filters: ReviewQueueFilters,
): Promise<EscalationThreadItem[]> {
  const result = await pool.query(
    `SELECT ct.id AS thread_id, e.id AS escalation_id, e.status, e.question,
            e.transaction_id, e.review_kind, e.severity, e.target_type,
            e.target_id, e.why_human, e.evidence, e.available_actions,
            e.review_due_at, e.occurrence_count, e.last_seen_at, e.created_at,
            (COUNT(*) OVER ())::int AS total_count
       FROM escalations e
       LEFT JOIN chat_threads ct ON ct.escalation_id = e.id
      WHERE (
          $1 = 'all'
          OR ($1 = 'open' AND e.status IN (
            'pending','in_agent_review','awaiting_human',
            'resolution_queued','rejection_queued','resolution_executing',
            'resolution_result_ready','resolution_attention'
          ))
          OR ($1 = 'closed' AND e.status NOT IN (
            'pending','in_agent_review','awaiting_human',
            'resolution_queued','rejection_queued','resolution_executing',
            'resolution_result_ready','resolution_attention'
          ))
        )
        AND ($2::text IS NULL OR e.review_kind = $2)
        AND ($3::text IS NULL OR e.severity = $3)
      ORDER BY
        CASE WHEN e.status = 'resolution_attention' THEN 0 ELSE 1 END,
        CASE e.status
          WHEN 'awaiting_human'  THEN 0
          WHEN 'pending'         THEN 1
          WHEN 'in_agent_review' THEN 2
          ELSE 3
        END,
        CASE WHEN e.review_due_at < now() THEN 0 ELSE 1 END,
        CASE e.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        e.review_due_at ASC NULLS LAST,
        e.last_seen_at DESC
      LIMIT $4 OFFSET $5`,
    [
      filters.lifecycle,
      filters.kind ?? null,
      filters.severity ?? null,
      filters.limit,
      filters.offset,
    ],
  );
  return (result.rows as EscalationThreadItem[]).map((row) => ({
    ...row,
    question: revealEscalationText(row.escalation_id, "question", row.question) ?? "",
  }));
}

export async function getThreadByEscalation(
  escalationId: string,
  db: Queryable = pool,
): Promise<ChatThreadRow | null> {
  const result = await db.query(
    `SELECT * FROM chat_threads WHERE escalation_id = $1`,
    [escalationId],
  );
  const row = result.rows[0] as ChatThreadRow | undefined;
  return row ? revealThread(row) : null;
}

/// Get-or-create the free-form operator chat thread for a wallet. The
/// unique partial index (escalation_id IS NULL) keeps it to one per
/// wallet; concurrent first-loads converge instead of 500ing (audit 3.9):
/// the insert tolerates the unique violation and re-selects the winner.
export async function getOrCreateFreeFormThread(
  walletAddress: string,
): Promise<ChatThreadRow> {
  const wallet = walletAddress.toLowerCase();
  const existing = await pool.query(
    `SELECT * FROM chat_threads WHERE wallet_address = $1 AND escalation_id IS NULL`,
    [wallet],
  );
  if (existing.rows[0]) return revealThread(existing.rows[0] as ChatThreadRow);
  const id = randomUUID();
  // The partial unique index is not addressable by ON CONFLICT's column
  // inference here (escalation_id IS NULL predicate), so tolerate the
  // race explicitly: a unique violation means another request won.
  try {
    const inserted = await pool.query(
      `INSERT INTO chat_threads (id, wallet_address, title, status)
       VALUES ($1, $2, $3, 'open')
       RETURNING *`,
      [id, wallet, encryptString("Operator chat", titleContext(id))],
    );
    return revealThread(inserted.rows[0] as ChatThreadRow);
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    const winner = await pool.query(
      `SELECT * FROM chat_threads WHERE wallet_address = $1 AND escalation_id IS NULL`,
      [wallet],
    );
    if (!winner.rows[0]) throw err;
    return revealThread(winner.rows[0] as ChatThreadRow);
  }
}

/// Get-or-create the chat thread bound to an escalation. wallet_address is
/// left null until a human engages; the runner creates it eagerly so the
/// agent has somewhere to post. Concurrent first-loads converge (23505 →
/// re-select the winner), same as the free-form thread.
export async function getOrCreateEscalationThread(args: {
  escalationId: string;
  title: string;
}, db: Queryable = pool): Promise<ChatThreadRow> {
  const existing = await getThreadByEscalation(args.escalationId, db);
  if (existing) return existing;
  const id = randomUUID();
  try {
    const inserted = await db.query(
      `INSERT INTO chat_threads (id, escalation_id, title, status)
       VALUES ($1, $2, $3, 'open')
       RETURNING *`,
      [id, args.escalationId, encryptString(args.title, titleContext(id))],
    );
    return revealThread(inserted.rows[0] as ChatThreadRow);
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    const winner = await getThreadByEscalation(args.escalationId, db);
    if (!winner) throw err;
    return winner;
  }
}

export async function touchChatThread(id: string): Promise<void> {
  await pool.query(`UPDATE chat_threads SET updated_at = now() WHERE id = $1`, [id]);
}

/// Attach a wallet to an escalation thread the first time a human engages,
/// so audit trails on that thread attribute to them.
export async function setChatThreadWallet(
  id: string,
  walletAddress: string,
): Promise<void> {
  await pool.query(
    `UPDATE chat_threads SET wallet_address = $2 WHERE id = $1 AND wallet_address IS NULL`,
    [id, walletAddress.toLowerCase()],
  );
}

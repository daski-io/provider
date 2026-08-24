import type { TransactionRow } from "../../../db/queries/transactions.js";
import type { EscalationRow } from "../../../db/queries/escalations.js";
import type { Tool, ToolDefinition } from "../../types.js";

// Operator Agent tool surface. Each tool has:
//   - `definition`  — OpenAI-compatible function schema
//   - `execute`     — runtime implementation
//
// Action / write tools take an `actor` (the SIWE-authenticated wallet, or
// 'operator_agent' in autonomous escalation runs) so audit trails
// attribute changes correctly.

/// Quick-action button surfaced under an agent message in the chat UI.
/// Clicking posts `value` (or, for "__freetext__", the typed text) back
/// into the thread, re-invoking the agent.
export interface SuggestedAction {
  label: string;
  value: string;
}

export interface ToolContext {
  actor: string;
  /** The chat thread this turn runs in (set for thread-scoped turns). */
  threadId?: string;
  /** Internal SIWE session id. Consequential intents are bound to it. */
  sessionId?: string;
  /** The persisted operator message id that initiated this HTTP turn. */
  turnId?: string;
  /** The escalation being worked, if this is an escalation thread. */
  escalationId?: string | null;
  /** free_form = the operator's open-ended chat; human = a human reply on
   *  an escalation thread; autonomous = the Operator Agent triaging a
   *  freshly-dispatched escalation with no human in the loop. */
  mode?: "free_form" | "human" | "autonomous";
  /** Set only by the SIWE + same-origin protected admin action controller
   * after the operator retypes the review id. Never populate from model input. */
  directAdminApproval?: true;
  /** Mutable scratch for the escalation flow. request_human_review stashes
   *  its buttons here for the runner to attach to the final agent message;
   *  the flags tell the runner the turn's disposition. */
  suggestedActions?: SuggestedAction[] | null;
  humanReviewRequested?: boolean;
  escalationClosed?: boolean;
}

export type OperatorTool = Tool<ToolContext>;

export type { Tool, ToolDefinition };

export function summarizeTransaction(t: TransactionRow): string {
  return `${t.id.slice(0, 12)}… ${t.skill_id} (${t.status}) at ${t.created_at.toISOString().slice(0, 19)}`;
}

export function summarizeEscalation(e: EscalationRow): string {
  return `${e.id.slice(0, 8)}… [${e.status}] ${e.question.slice(0, 120)}`;
}

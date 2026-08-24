import {
  getEscalationById,
  markEscalationAwaitingHuman,
  setEscalationThread,
} from "../../db/queries/escalations.js";
import { getOrCreateEscalationThread } from "../../db/queries/chatThreads.js";
import { appendOperatorChatMessage } from "../../db/queries/operatorChats.js";
import { loadEscalationContext, summarizeEscalationContext } from "./escalationContext.js";
import { runOperatorLoop } from "./index.js";
import { emitEvent } from "../../events/emitter.js";
import { logError } from "../../logger.js";

// Autonomous escalation dispatcher. Invoked fire-and-forget by the Email
// Agent's escalate_to_operator tool after it inserts an
// 'in_agent_review' escalation. Mirrors the Email-Agent dispatch: gives
// the Operator Agent its own thread, seeds the triggering turn, and runs
// the shared loop in autonomous mode. The agent then either resolves the
// escalation or surfaces it to a human via request_human_review.

export async function processEscalation(escalationId: string): Promise<void> {
  const escalation = await getEscalationById(escalationId);
  if (!escalation) {
    logError("processEscalation: escalation missing", { escalationId });
    return;
  }
  if (escalation.status !== "in_agent_review") {
    // Already triaged (or not assigned to the agent) — idempotent no-op.
    return;
  }
  if (
    escalation.source !== "email_agent" ||
    escalation.review_kind !== "email_triage" ||
    escalation.assignee !== "operator_agent"
  ) {
    await markEscalationAwaitingHuman({
      id: escalationId,
      agent_recommendation:
        "This review is outside the bounded email-triage authority and requires a human.",
    });
    return;
  }

  const context = await loadEscalationContext(escalationId);
  if (!context) return;

  // Bind a chat thread to this escalation so the agent (and later a human)
  // have somewhere to converse.
  const title =
    context.service
      ? `Escalation · ${context.service.slug}`
      : "Escalation";
  const thread = await getOrCreateEscalationThread({ escalationId, title });
  if (escalation.thread_id !== thread.id) {
    await setEscalationThread(escalationId, thread.id);
  }

  // Seed the triggering turn so the loop has a user message to act on.
  await appendOperatorChatMessage({
    threadId: thread.id,
    walletAddress: "operator_agent",
    role: "operator",
    content:
      "A new escalation has been assigned to you for autonomous triage. " +
      "Review the case context in the system prompt and act now.",
  });

  await emitEvent({
    transactionId: escalation.transaction_id ?? undefined,
    source: "llm",
    type: "escalation.agent_review_started",
    actor: "operator_agent",
    message: `Operator Agent triaging escalation ${escalationId.slice(0, 8)}…`,
    payload: { escalationId, threadId: thread.id },
  });

  try {
    await runOperatorLoop({
      threadId: thread.id,
      actor: "operator_agent",
      escalationId,
      mode: "autonomous",
      escalationContext: summarizeEscalationContext(context),
    });
  } catch (err) {
    logError("processEscalation: operator loop threw", {
      escalationId,
      error: (err as Error).message,
    });
  }
  // A model turn can end without selecting a disposition tool. The CAS makes
  // this a no-op when the agent did resolve/surface the case; otherwise it is
  // recoverably handed to a human instead of remaining in_agent_review.
  await markEscalationAwaitingHuman({
    id: escalationId,
    agent_recommendation:
      "Autonomous triage ended without a durable disposition. Human review is required.",
  });
}

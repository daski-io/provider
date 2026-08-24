import type { Request, Response, Router } from "express";
import { handleOperatorTurn } from "../../agents/operatorAgent/index.js";
import { approveConfirmationIntent } from "../../db/queries/confirmationIntentApprovals.js";
import {
  getConfirmationIntentStates,
  listPendingConfirmationIntentsForThreads,
} from "../../db/queries/confirmationIntents.js";
import {
  getChatThreadById,
  getOrCreateEscalationThread,
  getThreadByEscalation,
  setChatThreadWallet,
} from "../../db/queries/chatThreads.js";
import { getEscalationById, setEscalationThread } from "../../db/queries/escalations.js";
import { listChatThreadMessages } from "../../db/queries/operatorChats.js";
import { escapeAttr } from "./layouts.js";
import { confirmationCsrfToken, validConfirmationCsrfToken } from "./csrf.js";
import { readFormBody, sessionIdFromReq, walletFromReq } from "./util.js";
import {
  collectConfirmationIntentIds,
  renderBubble,
  renderPendingApprovalsBar,
} from "./pages/chat/bubbles.js";

async function ensureReviewThread(escalationId: string) {
  const existing = await getThreadByEscalation(escalationId);
  if (existing) return existing;
  const review = await getEscalationById(escalationId);
  if (!review) return null;
  const thread = await getOrCreateEscalationThread({
    escalationId,
    title: `Review · ${review.review_kind ?? review.source}`,
  });
  await setEscalationThread(escalationId, thread.id);
  return thread;
}

export async function renderReviewConversation(
  req: Request,
  escalationId: string,
): Promise<string> {
  const wallet = walletFromReq(req);
  const sessionId = sessionIdFromReq(req);
  if (!wallet || !sessionId) return "";
  const thread = await ensureReviewThread(escalationId);
  if (!thread) return `<div class="card">Review conversation is unavailable.</div>`;
  const messages = await listChatThreadMessages(thread.id, 200);
  const [states, pending] = await Promise.all([
    getConfirmationIntentStates(collectConfirmationIntentIds(messages)),
    listPendingConfirmationIntentsForThreads({
      threadIds: [thread.id],
      operatorWallet: wallet,
      sessionId,
    }),
  ]);
  const replyAction = `/admin/ui/reviews/${encodeURIComponent(escalationId)}/reply`;
  const csrf = confirmationCsrfToken({ sessionId, wallet, threadId: thread.id });
  const history = messages.map((message) =>
    renderBubble(message, replyAction, states, "/admin/ui/reviews/confirm", csrf)).join("");
  return `<section class="card">
    <h3>Review conversation</h3>
    <div style="display:flex; flex-direction:column;">${history || `<p class="dim">No conversation yet.</p>`}</div>
    <form method="POST" action="${escapeAttr(replyAction)}" style="display:flex; gap:8px; margin-top:12px;">
      <input class="input" name="message" placeholder="Reply to this review…" required>
      <button class="btn btn--primary" type="submit">Reply</button>
    </form>
    <div style="margin-top:10px;">${renderPendingApprovalsBar(pending)}</div>
  </section>`;
}

export function mountReviewConversationRoutes(router: Router): void {
  router.post("/reviews/:id/reply", async (req: Request, res: Response) => {
    const wallet = walletFromReq(req);
    const sessionId = sessionIdFromReq(req);
    if (!wallet || !sessionId) return void res.redirect("/admin/ui/login");
    const escalationId = String(req.params.id);
    const thread = await ensureReviewThread(escalationId);
    if (!thread) return void res.status(404).type("html").send("Review not found");
    const message = (await readFormBody(req)).get("message")?.trim();
    if (message) {
      if (!thread.wallet_address) await setChatThreadWallet(thread.id, wallet);
      await handleOperatorTurn({
        threadId: thread.id,
        walletAddress: wallet,
        sessionId,
        operatorMessage: message,
        escalationId,
      });
    }
    res.redirect(`/admin/ui/reviews/${encodeURIComponent(escalationId)}`);
  });

  router.post("/reviews/confirm", async (req: Request, res: Response) => {
    const wallet = walletFromReq(req);
    const sessionId = sessionIdFromReq(req);
    if (!wallet || !sessionId) return void res.redirect("/admin/ui/login");
    const form = await readFormBody(req);
    const threadId = form.get("thread_id") ?? "";
    if (!validConfirmationCsrfToken(form.get("csrf_token") ?? "", {
      sessionId,
      wallet,
      threadId,
    })) return void res.status(403).type("html").send("Invalid confirmation request");
    const thread = threadId ? await getChatThreadById(threadId) : null;
    if (!thread?.escalation_id) {
      return void res.status(404).type("html").send("Review thread not found");
    }
    const approval = await approveConfirmationIntent({
      intentId: form.get("intent_id") ?? "",
      operatorWallet: wallet,
      sessionId,
      threadId,
    });
    if (!approval.ok || thread.id !== approval.threadId) {
      return void res.status(409).type("html").send("Approval is no longer valid");
    }
    if (!approval.newlyApproved) {
      return void res.redirect(`/admin/ui/reviews/${encodeURIComponent(thread.escalation_id)}`);
    }
    await handleOperatorTurn({
      threadId,
      walletAddress: wallet,
      sessionId,
      operatorMessage:
        `I explicitly approve ${approval.actionName} for ${approval.targetType} ` +
        `${approval.targetId}. Execute only the exact previewed intent.`,
      escalationId: thread.escalation_id,
    });
    res.redirect(`/admin/ui/reviews/${encodeURIComponent(thread.escalation_id)}`);
  });
}

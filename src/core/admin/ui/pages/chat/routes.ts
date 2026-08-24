import type { Request, Response, Router } from "express";
import { handleOperatorTurn } from "../../../../agents/operatorAgent/index.js";
import { approveConfirmationIntent } from "../../../../db/queries/confirmationIntentApprovals.js";
import {
  getChatThreadById,
  getOrCreateFreeFormThread,
  type ChatThreadRow,
} from "../../../../db/queries/chatThreads.js";
import { clearChatThreadMessages } from "../../../../db/queries/operatorChats.js";
import { logError } from "../../../../logger.js";
import {
  readFormBody,
  sessionIdFromReq,
  walletFromReq,
  walletShortFromReq,
} from "../../util.js";
import { canAccessChatThread } from "./access.js";
import { renderOperatorChatPage } from "./page.js";
import { validConfirmationCsrfToken } from "../../csrf.js";
async function accessibleThread(
  threadId: string,
  wallet: string,
): Promise<ChatThreadRow | null> {
  const thread = await getChatThreadById(threadId);
  return thread && canAccessChatThread(thread, wallet) ? thread : null;
}

export function mountChatPage(router: Router): void {
  router.get("/chat", async (req: Request, res: Response) => {
    const wallet = walletFromReq(req);
    if (!wallet) {
      res.redirect("/admin/ui/login");
      return;
    }
    const html = await renderOperatorChatPage({
      wallet,
      sessionId: sessionIdFromReq(req) ?? null,
      walletShort: walletShortFromReq(req),
      confirmFlash: req.query.confirm === "failed",
    });
    res.type("html").send(html);
  });

  router.post("/chat", async (req: Request, res: Response) => {
    const wallet = walletFromReq(req);
    const sessionId = sessionIdFromReq(req);
    if (!wallet || !sessionId) {
      res.redirect("/admin/ui/login");
      return;
    }
    const form = await readFormBody(req);
    const message = form.get("message")?.trim();
    if (!message) {
      res.redirect("/admin/ui/chat");
      return;
    }
    const thread = await getOrCreateFreeFormThread(wallet);
    try {
      await handleOperatorTurn({
        threadId: thread.id,
        walletAddress: wallet,
        sessionId,
        operatorMessage: message,
      });
    } catch (err) {
      logError("operator chat turn threw", { error: (err as Error).message });
    }
    res.redirect("/admin/ui/chat");
  });

  router.post("/chat/clear", async (req: Request, res: Response) => {
    const wallet = walletFromReq(req);
    if (!wallet) {
      res.redirect("/admin/ui/login");
      return;
    }
    const thread = await getOrCreateFreeFormThread(wallet);
    await clearChatThreadMessages(thread.id);
    res.redirect("/admin/ui/chat");
  });

  router.post("/chat/confirm", async (req: Request, res: Response) => {
    const wallet = walletFromReq(req);
    const sessionId = sessionIdFromReq(req);
    if (!wallet || !sessionId) {
      res.redirect("/admin/ui/login");
      return;
    }
    const form = await readFormBody(req);
    const intentId = form.get("intent_id") ?? "";
    const threadId = form.get("thread_id") ?? "";
    if (!validConfirmationCsrfToken(form.get("csrf_token") ?? "", {
      sessionId,
      wallet,
      threadId,
    })) {
      res.status(403).type("html").send("Invalid confirmation request");
      return;
    }
    const thread = await accessibleThread(threadId, wallet);
    if (!thread || thread.escalation_id) {
      res.status(404).type("html").send("Thread not found");
      return;
    }
    const approval = await approveConfirmationIntent({
      intentId,
      operatorWallet: wallet,
      sessionId,
      threadId,
    });
    if (!approval.ok) {
      res.redirect("/admin/ui/chat?confirm=failed");
      return;
    }
    if (!approval.newlyApproved) {
      res.redirect("/admin/ui/chat");
      return;
    }
    await handleOperatorTurn({
      threadId: thread.id,
      walletAddress: wallet,
      sessionId,
      operatorMessage:
        `I explicitly approve ${approval.actionName} for ` +
        `${approval.targetType} ${approval.targetId}. Execute only the exact previewed intent.`,
    });
    res.redirect("/admin/ui/chat");
  });
}

import {
  listChatThreadMessages,
} from "../../../../db/queries/operatorChats.js";
import {
  getOrCreateFreeFormThread,
} from "../../../../db/queries/chatThreads.js";
import {
  getConfirmationIntentStates,
  listPendingConfirmationIntentsForThreads,
} from "../../../../db/queries/confirmationIntents.js";
import { renderLayout } from "../../layouts.js";
import {
  collectConfirmationIntentIds,
  renderBubble,
  renderPendingApprovalsBar,
} from "./bubbles.js";
import { chatEnhancementBlock } from "./enhancement.js";
import { confirmationCsrfToken } from "../../csrf.js";

export async function renderOperatorChatPage(args: {
  wallet: string;
  sessionId: string | null;
  walletShort: string | undefined;
  confirmFlash: boolean;
}): Promise<string> {
  const freeFormThread = await getOrCreateFreeFormThread(args.wallet);
  const history = await listChatThreadMessages(freeFormThread.id, 200);
  const [intentStates, pendingApprovals] = await Promise.all([
    getConfirmationIntentStates(collectConfirmationIntentIds(history)),
    args.sessionId
      ? listPendingConfirmationIntentsForThreads({
          threadIds: [freeFormThread.id],
          operatorWallet: args.wallet,
          sessionId: args.sessionId,
        })
      : Promise.resolve([]),
  ]);
  const csrfToken = args.sessionId
    ? confirmationCsrfToken({
        sessionId: args.sessionId,
        wallet: args.wallet,
        threadId: freeFormThread.id,
      })
    : undefined;

  const historyHtml = history
    .map((row) => renderBubble(row, "/admin/ui/chat", intentStates, "/admin/ui/chat/confirm", csrfToken))
    .join("");
  const emptyState = `<div class="dim" data-empty style="text-align:center; padding:30px 0;">
      <p>Hi. I'm the operator agent. Ask me about standard transactions, reviews, services, rules, legal holds, provider writes, or reputation outcomes.</p>
      <p style="font-size:12px; margin-top:6px;">Try: "How many transactions did we have in the last 24 hours?"</p>
    </div>`;
  const flash = args.confirmFlash
    ? `<div style="border:1px solid #a33; background:rgba(220,60,60,0.10); border-radius:8px; padding:8px 12px; margin-bottom:8px; font-size:12.5px;">
        That approval was no longer valid (expired, superseded, already used, or from another session).
        Ask the agent to run the action again — a fresh <b>Approve exact action</b> button will appear.
      </div>`
    : "";
  const page = `
    <div style="max-width:900px; margin:0;">
      <div id="chat-stream" style="display:flex; flex-direction:column; padding:8px 0 14px;">
        ${historyHtml || emptyState}
      </div>
      <div style="position:sticky; bottom:0; background:var(--pro-bg); padding:14px 0; border-top:1px solid var(--pro-border); z-index:4;">
        ${flash}
        ${renderPendingApprovalsBar(pendingApprovals)}
        <div style="display:flex; gap:8px;">
          <form method="POST" action="/admin/ui/chat" style="display:flex; gap:8px; flex:1;" data-chat-form>
            <input class="input" name="message" placeholder="Message the operator agent…" autocomplete="off" required style="flex:1;">
            <button class="btn btn--primary" type="submit">Send</button>
          </form>
          <form method="POST" action="/admin/ui/chat/clear">
            <button class="btn" type="submit" title="Clear chat history">Reset</button>
          </form>
        </div>
      </div>
    </div>
    ${chatEnhancementBlock()}`;
  return renderLayout({
    page: "chat",
    title: "Operator",
    body: page,
    walletShort: args.walletShort,
  });
}

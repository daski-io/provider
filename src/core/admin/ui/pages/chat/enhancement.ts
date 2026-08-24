import type { OperatorChatRow } from "../../../../db/queries/operatorChats.js";
import { renderBubble } from "./bubbles.js";

/**
 * Adds optimistic sending and live approval countdowns. The underlying forms
 * remain usable without JavaScript.
 */
export function chatEnhancementBlock(): string {
  const operatorBubble = renderBubble(
    { role: "operator", content: "" } as OperatorChatRow,
    "/admin/ui/chat",
  );
  return `
    <link rel="stylesheet" href="/admin/ui/static/chat.css">
    <template id="tpl-operator-bubble">${operatorBubble}</template>
    <template id="tpl-typing">
      <div style="align-self:flex-start; margin-bottom:10px;"><div class="typing-bubble"><span></span><span></span><span></span></div></div>
    </template>
    <script src="/admin/ui/static/chat.js" defer></script>`;
}

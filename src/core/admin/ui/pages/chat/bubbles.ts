import type {
  ConfirmationIntentState,
  PendingThreadIntent,
} from "../../../../db/queries/confirmationIntents.js";
import type { OperatorChatRow } from "../../../../db/queries/operatorChats.js";
import { escapeAttr, escapeHtml } from "../../layouts.js";

interface SuggestedAction {
  label: string;
  value: string;
}

function bubbleClass(role: OperatorChatRow["role"]): {
  align: string;
  bg: string;
  border: string;
  fg: string;
} {
  if (role === "operator") {
    return {
      align: "flex-end",
      bg: "rgba(28,186,153,0.12)",
      border: "1px solid #107562",
      fg: "var(--fg-1)",
    };
  }
  return {
    align: "flex-start",
    bg: "var(--pro-surface2)",
    border: "1px solid var(--pro-border)",
    fg: role === "tool" ? "var(--fg-3)" : "var(--fg-1)",
  };
}

function renderSuggestedActions(actions: SuggestedAction[], postAction: string): string {
  const buttons = actions
    .filter((action) => action.value !== "__freetext__")
    .map(
      (action) => `
        <form method="POST" action="${escapeAttr(postAction)}" style="display:inline;" data-chat-form>
          <input type="hidden" name="message" value="${escapeAttr(action.value)}">
          <button class="btn" type="submit">${escapeHtml(action.label)}</button>
        </form>`,
    )
    .join("");
  const hint = actions.some((action) => action.value === "__freetext__")
    ? `<span class="dim" style="font-size:11.5px; align-self:center;">or use the Reply box below</span>`
    : "";
  return `<div class="row" style="gap:6px; flex-wrap:wrap; margin-top:8px;">${buttons}${hint}</div>`;
}

function renderIntentApproval(
  intentId: string,
  threadId: string,
  state: ConfirmationIntentState | undefined,
  confirmAction: string,
  csrfToken?: string,
): string {
  const anchor = `intent-${escapeAttr(intentId)}`;
  const note = (text: string) =>
    `<div id="${anchor}" class="dim" style="font-size:11.5px; margin:6px 0 10px;">${escapeHtml(text)}</div>`;
  if (!state) return note("Approval no longer available — ask the agent to run the action again.");
  if (state.executionStatus === "succeeded") return note("✓ Approved and executed.");
  if (state.executionStatus === "executing") {
    return note("Approved — execution in progress.");
  }
  if (state.executionStatus === "failed") {
    return note(
      `Approved, but execution failed: ${
        state.executionErrorSummary ?? "No safe failure summary is available."
      }`,
    );
  }
  if (state.executionStatus === "outcome_unknown") {
    return note(
      "Approved, but the execution result could not be proved. Review before retrying.",
    );
  }
  if (state.voidedAt) {
    return note("Superseded by a newer preview of this action — approve that one instead.");
  }
  if (state.approvedAt) return note("Approved — waiting to execute.");
  if (state.expiresAt.getTime() <= Date.now()) {
    return note("Approval expired — ask the agent to run the action again for a fresh button.");
  }
  return `
          <form id="${anchor}" method="POST" action="${escapeAttr(confirmAction)}" style="margin:6px 0 10px;" data-confirmation-form>
            <input type="hidden" name="intent_id" value="${escapeAttr(intentId)}">
            <input type="hidden" name="thread_id" value="${escapeAttr(threadId)}">
            ${csrfToken ? `<input type="hidden" name="csrf_token" value="${escapeAttr(csrfToken)}">` : ""}
            <button class="btn btn--danger" type="submit">Approve exact action</button>
            <span class="dim" style="font-size:11.5px; margin-left:8px;" data-intent-countdown data-expires-at="${state.expiresAt.getTime()}">single-use · expires in ${Math.max(1, Math.round((state.expiresAt.getTime() - Date.now()) / 60_000))}m</span>
          </form>`;
}

export function renderBubble(
  row: OperatorChatRow,
  postAction: string,
  intentStates?: Map<string, ConfirmationIntentState>,
  confirmAction = "/admin/ui/chat/confirm",
  csrfToken?: string,
): string {
  const style = bubbleClass(row.role);
  if (row.role === "tool") {
    let body: string;
    let approval = "";
    try {
      const parsed = JSON.parse(row.content) as Record<string, unknown>;
      body = JSON.stringify(parsed, null, 2);
      if (
        parsed.reason === "confirmation_required" &&
        typeof parsed.confirmation_intent_id === "string" &&
        row.thread_id
      ) {
        approval = renderIntentApproval(
          parsed.confirmation_intent_id,
          row.thread_id,
          intentStates?.get(parsed.confirmation_intent_id),
          confirmAction,
          csrfToken,
        );
      }
    } catch {
      body = row.content;
    }
    return `
      <details style="align-self:${style.align}; max-width:80%; margin-bottom:10px;">
        <summary style="font-family:var(--font-mono); font-size:11px; color:var(--fg-3); cursor:pointer; padding:6px 10px; border:1px dashed var(--pro-border); border-radius:6px;">
          tool result · ${escapeHtml(row.tool_call_id ?? "")}
        </summary>
        <pre style="margin:6px 0 0; padding:10px 12px; background:var(--pro-bg); border:1px solid var(--pro-border); border-radius:6px; font-size:11px; max-height:300px; overflow:auto;">${escapeHtml(body)}</pre>
      </details>${approval}`;
  }
  if (row.role === "agent" && row.tool_calls) {
    const toolCalls = row.tool_calls as Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
    const names = toolCalls.map((call) => call.function.name).join(", ");
    const detailBody = toolCalls
      .map(
        (call) =>
          `${escapeHtml(call.function.name)}(${escapeHtml(call.function.arguments)})`,
      )
      .join("\n\n");
    const text = row.content
      ? `<div style="align-self:${style.align}; background:${style.bg}; border:${style.border}; color:${style.fg}; padding:10px 14px; border-radius:10px; max-width:80%; margin-bottom:6px; white-space:pre-wrap;">${escapeHtml(row.content)}</div>`
      : "";
    return `
      ${text}
      <details style="align-self:${style.align}; max-width:80%; margin-bottom:10px;">
        <summary style="font-family:var(--font-mono); font-size:11px; color:var(--fg-3); cursor:pointer; padding:6px 10px; border:1px dashed var(--pro-border); border-radius:6px;">
          tool call · ${escapeHtml(names)}
        </summary>
        <pre style="margin:6px 0 0; padding:10px 12px; background:var(--pro-bg); border:1px solid var(--pro-border); border-radius:6px; font-size:11px; max-height:300px; overflow:auto; white-space:pre-wrap; word-break:break-word;">${escapeHtml(detailBody)}</pre>
      </details>`;
  }
  let actions = "";
  if (row.role === "agent" && Array.isArray(row.suggested_actions)) {
    actions = renderSuggestedActions(row.suggested_actions as SuggestedAction[], postAction);
  }
  return `
    <div style="display:flex; flex-direction:column; align-items:${style.align === "flex-end" ? "flex-end" : "flex-start"}; max-width:80%; align-self:${style.align}; margin-bottom:10px;">
      <div style="background:${style.bg}; border:${style.border}; color:${style.fg}; padding:10px 14px; border-radius:10px; white-space:pre-wrap;">${escapeHtml(row.content)}</div>
      ${actions}
    </div>`;
}

export function collectConfirmationIntentIds(rows: OperatorChatRow[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (row.role !== "tool") continue;
    try {
      const parsed = JSON.parse(row.content) as Record<string, unknown>;
      if (
        parsed.reason === "confirmation_required" &&
        typeof parsed.confirmation_intent_id === "string"
      ) {
        ids.push(parsed.confirmation_intent_id);
      }
    } catch {
      // Non-JSON tool output has no confirmation intent.
    }
  }
  return ids;
}

export function renderPendingApprovalsBar(pending: PendingThreadIntent[]): string {
  if (pending.length === 0) return "";
  const rows = pending
    .map(
      (intent) => `
      <div style="display:flex; gap:10px; align-items:center; margin:4px 0;">
        <span class="mono" style="font-size:12px;">${escapeHtml(intent.actionName)} · ${escapeHtml(intent.targetType)} ${escapeHtml(intent.targetId.slice(0, 12))}${intent.targetId.length > 12 ? "…" : ""}</span>
        <span class="dim" style="font-size:11.5px;" data-intent-countdown data-expires-at="${intent.expiresAt.getTime()}">expires in ${Math.max(1, Math.round((intent.expiresAt.getTime() - Date.now()) / 60_000))}m</span>
        <a class="btn" style="margin-left:auto;" href="#intent-${escapeAttr(intent.id)}">Review approval</a>
      </div>`,
    )
    .join("");
  return `
      <div id="pending-approvals" style="border:1px solid #8a4b2d; background:rgba(220,120,60,0.08); border-radius:8px; padding:8px 12px; margin-bottom:8px;">
        <div style="font-size:12px; font-weight:600; color:var(--fg-1); margin-bottom:2px;">Approval required. Open the exact preview below; the approval button appears only there.</div>
        ${rows}
      </div>`;
}

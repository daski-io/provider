// Model-facing presentation of a pending confirmation. Dependency-free on
// purpose: tools import this alongside the gate, and tests that mock the gate
// module keep the real presentation.

export interface PendingConfirmation {
  status: "pending";
  intentId: string;
  expiresAt: Date;
  /** true when this call minted a fresh intent; false when a live Approve
   *  button from an earlier preview is still awaiting the click. */
  issued: boolean;
}

/**
 * Build the tool-result JSON for a pending confirmation. The instructions are
 * written for the model: they name the only valid approval path (the rendered
 * Approve exact action button) so the agent never coaches the operator to
 * type an approval, and they say what to do when the button expires.
 */
export function confirmationPendingResult(
  pending: PendingConfirmation,
  content: {
    /** Human-facing preview sentence (consequences of the action). */
    message: string;
    /** The previewed content, echoed for the operator/model to review. */
    pending: Record<string, unknown>;
    extra?: Record<string, unknown>;
  },
): string {
  const minutes = Math.max(
    1,
    Math.round((pending.expiresAt.getTime() - Date.now()) / 60_000),
  );
  const instructions = pending.issued
    ? `An "Approve exact action" button now renders under this tool result ` +
      `(single-use, expires in ~${minutes} min; also pinned above the reply box). ` +
      `Tell the operator to review the preview and click that button. A typed chat ` +
      `reply can NEVER approve this — do not ask for one. Do not call this tool ` +
      `again while waiting: the approval click automatically posts a new operator ` +
      `message, and repeating this exact call from that turn executes the action. ` +
      `If the button expires, calling this tool again mints a fresh one.`
    : `This exact action is already awaiting browser approval — the "Approve exact ` +
      `action" button from the earlier preview is still live (expires in ~${minutes} min; ` +
      `also pinned above the reply box). Point the operator there. A typed chat reply ` +
      `can NEVER approve it; do not call this tool again until the approval message arrives.`;
  return JSON.stringify({
    ok: false,
    reason: "confirmation_required",
    message: content.message,
    approval_instructions: instructions,
    confirmation_intent_id: pending.intentId,
    expires_in_minutes: minutes,
    pending: content.pending,
    ...content.extra,
  });
}

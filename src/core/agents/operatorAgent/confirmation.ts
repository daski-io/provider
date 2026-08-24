import {
  canonicalActionArguments,
  completeConfirmationExecution,
  consumeApprovedConfirmationIntent,
  createConfirmationIntent,
  failConfirmationExecution,
  findOpenConfirmationIntent,
  voidConfirmationIntent,
} from "../../db/queries/confirmationIntents.js";
import type { PendingConfirmation } from "./confirmationPresentation.js";
import type { ToolContext } from "./tools/shared.js";

interface ConfirmationGateArgs {
  ctx: ToolContext;
  actionName: string;
  /** Stable identifying arguments (ids, amounts, action names). A later call
   *  must reproduce them exactly to consume the approval. */
  arguments: Record<string, unknown>;
  /** Model-authored content (reason, disposition, rule text, params). Stored
   *  server-side at preview time and returned on approval — the approved
   *  preview's content is what executes, never a later retyping. */
  payload?: Record<string, unknown>;
  targetType: string;
  targetId: string;
}

export type ConfirmationGateResult =
  | { status: "approved"; intentId: string; payload: Record<string, unknown> }
  | PendingConfirmation
  | { status: "denied"; reason: string; message: string };

/**
 * Issue or atomically consume a server-side confirmation intent.
 *
 * Lifecycle per call, for one exact binding (operator, session, thread,
 * action, stable arguments, target):
 *   1. A browser-approved intent from an earlier operator turn exists →
 *      consume it and return its stored payload for execution.
 *   2. A live not-yet-approved intent exists →
 *        - same payload: point back at its still-valid Approve button
 *          (no duplicate is minted);
 *        - changed payload: the re-preview supersedes it — void the old
 *          intent and mint a fresh one, so exactly one live button exists
 *          and it always reflects the latest previewed content.
 *   3. Nothing live (never previewed, or the intent expired) → mint a fresh
 *      intent, which renders a fresh Approve button.
 *
 * Only the authenticated browser POST can approve an intent, and approval
 * automatically posts the follow-up operator turn that step 1 executes from.
 * An intent approved during the same turn that previewed it is refused until
 * that follow-up turn runs (no same-turn self-confirmation).
 */
export async function confirmationGate(
  args: ConfirmationGateArgs,
): Promise<ConfirmationGateResult> {
  const { ctx } = args;
  const humanMode = ctx.mode === "free_form" || ctx.mode === "human";
  if (ctx.directAdminApproval && humanMode && ctx.actor) {
    return {
      status: "approved",
      intentId: "direct-admin",
      payload: args.payload ?? {},
    };
  }
  if (!humanMode || !ctx.sessionId || !ctx.threadId || !ctx.turnId) {
    return {
      status: "denied",
      reason: "confirmation_context_required",
      message: "A signed-in human session, thread, and distinct operator turn are required.",
    };
  }
  const payload = args.payload ?? {};
  const binding = {
    operatorWallet: ctx.actor,
    sessionId: ctx.sessionId,
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    actionName: args.actionName,
    arguments: args.arguments,
    targetType: args.targetType,
    targetId: args.targetId,
  };

  const consumed = await consumeApprovedConfirmationIntent(binding);
  if (consumed) {
    return {
      status: "approved",
      intentId: consumed.id,
      payload: consumed.payload,
    };
  }

  const open = await findOpenConfirmationIntent(binding);
  if (open) {
    if (open.approvedAt) {
      // Approved but not consumable: the approval landed while the turn that
      // previewed it was still running. The approval click has already posted
      // the follow-up operator message; execution belongs to that turn.
      return {
        status: "denied",
        reason: "same_turn_confirmation",
        message:
          "The browser approval was registered, but execution must run from a " +
          "distinct later operator turn. The approval click has already posted a " +
          "follow-up operator message — stop here; the action executes when that " +
          "message is processed.",
      };
    }
    if (canonicalActionArguments(open.pendingPayload) === canonicalActionArguments(payload)) {
      return { status: "pending", intentId: open.id, expiresAt: open.expiresAt, issued: false };
    }
    await voidConfirmationIntent(open.id, binding.operatorWallet);
  }

  const fresh = await createConfirmationIntent(binding, payload);
  return { status: "pending", intentId: fresh.id, expiresAt: fresh.expiresAt, issued: true };
}

/** Records the outcome boundary for one browser-approved consequential action. */
export async function executeConfirmedAction<T>(
  approved: { intentId: string },
  work: () => Promise<T>,
  options?: {
    isSuccess(result: T): boolean;
    failureSummary(result: T): string;
  },
): Promise<T> {
  if (approved.intentId === "direct-admin") return work();
  try {
    const result = await work();
    if (options && !options.isSuccess(result)) {
      await failConfirmationExecution(
        approved.intentId,
        new Error(options.failureSummary(result)),
      );
      return result;
    }
    await completeConfirmationExecution(approved.intentId);
    return result;
  } catch (error) {
    await failConfirmationExecution(approved.intentId, error);
    throw error;
  }
}

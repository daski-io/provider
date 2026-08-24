import { confirmationGate, executeConfirmedAction } from "../confirmation.js";
import { confirmationPendingResult } from "../confirmationPresentation.js";
import {
  listActiveLegalHolds,
  placeLegalHold,
  releaseLegalHold,
  type LegalHoldScope,
} from "../../../legalHold/commands.js";
import type { OperatorTool } from "./shared.js";

const scopes = ["transaction", "asset", "compliance_case"] as const;

export const listLegalHoldsTool: OperatorTool = {
  definition: {
    type: "function",
    function: {
      name: "list_legal_holds",
      description: "List active retention legal holds and their scopes.",
      parameters: { type: "object", properties: {} },
    },
  },
  async execute() {
    const holds = await listActiveLegalHolds();
    return JSON.stringify(holds.map((hold) => ({
      id: hold.id,
      scope_type: hold.scope_type,
      scope_id: hold.scope_id,
      reason: hold.reason,
      placed_at: hold.placed_at,
    })));
  },
};

export const placeLegalHoldTool: OperatorTool = {
  definition: {
    type: "function",
    function: {
      name: "place_legal_hold",
      description: "Place an auditable transaction, asset, or compliance-case retention hold. Two-step: preview, browser Approve exact action click, then repeat the call in the follow-up turn.",
      parameters: {
        type: "object",
        properties: {
          scope_type: { type: "string", enum: [...scopes] },
          scope_id: { type: "string" },
          reason: { type: "string", description: "Captured at preview time; the approved preview's reason is what persists." },
        },
        required: ["scope_type", "scope_id", "reason"],
      },
    },
  },
  async execute(args, ctx) {
    const scopeType = String(args.scope_type) as LegalHoldScope;
    const scopeId = String(args.scope_id);
    const reason = String(args.reason);
    if (!scopes.includes(scopeType)) return JSON.stringify({ ok: false, reason: "invalid_scope" });
    const confirmation = await confirmationGate({
      ctx,
      actionName: "place_legal_hold",
      arguments: { scope_type: scopeType, scope_id: scopeId },
      payload: { reason },
      targetType: scopeType,
      targetId: scopeId,
    });
    if (confirmation.status === "pending") {
      return confirmationPendingResult(confirmation, {
        message: `Place a retention legal hold on ${scopeType} ${scopeId}? Reason: "${reason}".`,
        pending: { scope_type: scopeType, scope_id: scopeId, reason },
      });
    }
    if (confirmation.status === "denied") {
      return JSON.stringify({ ok: false, reason: confirmation.reason, message: confirmation.message });
    }
    const result = await executeConfirmedAction(confirmation, () => placeLegalHold({
      scopeType,
      scopeId,
      // The human-approved preview's reason, not a retyped one.
      reason: String(confirmation.payload.reason ?? reason),
      actor: ctx.actor,
    }));
    return JSON.stringify({ ok: true, id: result.hold.id, created: result.created });
  },
};

export const releaseLegalHoldTool: OperatorTool = {
  definition: {
    type: "function",
    function: {
      name: "release_legal_hold",
      description: "Release a legal hold. Two-step: preview, browser Approve exact action click, then repeat the call in the follow-up turn.",
      parameters: {
        type: "object",
        properties: { hold_id: { type: "string" } },
        required: ["hold_id"],
      },
    },
  },
  async execute(args, ctx) {
    const holdId = String(args.hold_id);
    const confirmation = await confirmationGate({
      ctx,
      actionName: "release_legal_hold",
      arguments: { hold_id: holdId },
      targetType: "legal_hold",
      targetId: holdId,
    });
    if (confirmation.status === "pending") {
      return confirmationPendingResult(confirmation, {
        message: `Release legal hold ${holdId}?`,
        pending: { hold_id: holdId },
      });
    }
    if (confirmation.status === "denied") {
      return JSON.stringify({ ok: false, reason: confirmation.reason, message: confirmation.message });
    }
    const hold = await executeConfirmedAction(
      confirmation,
      () => releaseLegalHold(holdId, ctx.actor),
    );
    return JSON.stringify({ ok: true, id: hold.id, released_at: hold.released_at });
  },
};

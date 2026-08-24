import { replaceProviderWriteWithBoundedFee } from "../../../chain/providerWriteCoordinator.js";
import { getProviderWrite } from "../../../db/queries/providerChainWrites.js";
import { getEscalationById } from "../../../db/queries/escalations.js";
import { confirmationGate, executeConfirmedAction } from "../confirmation.js";
import { confirmationPendingResult } from "../confirmationPresentation.js";
import type { OperatorTool } from "./shared.js";

export const replaceProviderWriteFeeTool: OperatorTool = {
  definition: {
    type: "function",
    function: {
      name: "replace_provider_write_fee",
      description:
        "Prepare a bounded same-nonce fee replacement for the provider write bound "
        + "to the current nonce-gap review. Requires exact browser approval.",
      parameters: {
        type: "object",
        properties: {
          provider_write_id: { type: "string" },
        },
        required: ["provider_write_id"],
      },
    },
  },
  async execute(args, ctx) {
    if (ctx.mode === "autonomous" || !ctx.escalationId) {
      return JSON.stringify({ ok: false, reason: "human_review_required" });
    }
    const id = String(args.provider_write_id ?? "");
    const [review, write] = await Promise.all([
      getEscalationById(ctx.escalationId),
      getProviderWrite(id),
    ]);
    if (
      !review
      || review.review_kind !== "provider_nonce_gap"
      || review.target_type !== "provider_chain_write"
      || review.target_id !== id
      || !write
      || !["prepared", "broadcast", "attention"].includes(write.status)
    ) {
      return JSON.stringify({ ok: false, reason: "stale_or_mismatched_review" });
    }
    const confirmation = await confirmationGate({
      ctx,
      actionName: "replace_provider_write_fee",
      arguments: {
        provider_write_id: id,
        nonce: write.nonce,
        intent_hash: write.intent_hash,
      },
      payload: {},
      targetType: "provider_chain_write",
      targetId: id,
    });
    if (confirmation.status === "pending") {
      return confirmationPendingResult(confirmation, {
        message:
          `Re-sign identical intent ${write.intent_hash} at nonce ${write.nonce} `
          + "within the configured provider fee ceiling.",
        pending: { provider_write_id: id, nonce: write.nonce },
      });
    }
    if (confirmation.status === "denied") {
      return JSON.stringify({
        ok: false,
        reason: confirmation.reason,
        message: confirmation.message,
      });
    }
    const replacement = await executeConfirmedAction(
      confirmation,
      () => replaceProviderWriteWithBoundedFee(id),
    );
    return JSON.stringify({
      ok: true,
      provider_write_id: replacement.id,
      transaction_hash: replacement.hash,
      nonce: replacement.nonce.toString(),
    });
  },
};

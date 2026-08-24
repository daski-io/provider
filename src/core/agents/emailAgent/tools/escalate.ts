import { getTransactionById } from "../../../db/queries/transactions.js";
import { createEscalation } from "../../../db/queries/escalations.js";
import { linkInboundToTransaction } from "./helpers.js";
import { authorizeEmailTransaction } from "./authorization.js";
import type { EmailAgentTool } from "./context.js";

export const escalateToOperator: EmailAgentTool = {
  definition: {
    type: "function",
    function: {
      name: "escalate_to_operator",
      description:
        "Send this email to bounded operator-agent triage. It may reply or close a no-action case; every other outcome is handed to the audited human queue.",
      parameters: {
        type: "object",
        properties: {
          transaction_id: {
            type: "string",
            description: "The transaction id. Pass an empty string if the email isn't bound to a transaction (e.g. an unknown sender).",
          },
          question: {
            type: "string",
            description: "What you need decided, with the relevant context.",
          },
        },
        required: ["question"],
      },
    },
  },
  async execute(args, ctx) {
    let txId =
      typeof args.transaction_id === "string" && args.transaction_id.length > 0
        ? args.transaction_id
        : null;
    if (txId) {
      const transaction = await getTransactionById(txId);
      if (!transaction || !authorizeEmailTransaction(ctx, transaction).authorized) {
        return JSON.stringify({ ok: false, reason: "authentication_or_ownership_required" });
      }
      const linked = await linkInboundToTransaction(ctx, txId);
      if (!linked) {
        return JSON.stringify({ ok: false, reason: "link_failed" });
      }
      txId = linked.id;
    }
    // This is the only autonomous Operator Agent producer. The durable job is
    // inserted atomically by createEscalation and remains bound to this exact
    // inbound review; it cannot enumerate customers or invoke provider actions.
    const row = await createEscalation({
      transaction_id: txId ?? null,
      question: String(args.question),
      source: "email_agent",
      status: "in_agent_review",
      assignee: "operator_agent",
      inbound_id: ctx.inbound.id,
      review_kind: "email_triage",
      dedupe_key: `email-triage:${ctx.inbound.id}`,
      target_type: "email_inbound",
      target_id: ctx.inbound.id,
      why_human:
        "The email agent could not settle this inbound conversation. Bounded operator-agent "
        + "triage may reply or record no action; all other decisions require a human.",
      evidence: { inboundId: ctx.inbound.id },
      available_actions: [
        {
          label: "Close after reply",
          value: JSON.stringify({ tool: "close_email_triage", arguments: {
            disposition: "replied", note: "Describe the recorded reply.",
          } }),
          effect: "Requires an outbound email linked to this inbound message.",
        },
        {
          label: "Close with no action",
          value: JSON.stringify({ tool: "close_email_triage", arguments: {
            disposition: "no-action", note: "Explain why no reply or service action is needed.",
          } }),
          effect: "Records an explicit audited operator disposition.",
        },
      ],
    });
    return JSON.stringify({ ok: true, escalationId: row.id, assignee: "operator_agent" });
  },
};

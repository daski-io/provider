import {
  closeEscalation,
  countOpenEscalations,
  getEscalationById,
  listOpenEscalations,
  markEscalationAwaitingHuman,
} from "../../../db/queries/escalations.js";
import { sendEmail } from "../../../email/postmarkOutbound.js";
import { emitEvent } from "../../../events/emitter.js";
import {
  loadEscalationContext,
  summarizeEscalationContext,
} from "../escalationContext.js";
import { type OperatorTool, summarizeEscalation } from "./shared.js";

export const listOpenEscalationsTool: OperatorTool = {
  definition: {
    type: "function",
    function: {
      name: "list_open_reviews",
      description: "List current open provider reviews. Available only in authenticated human chat.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async execute() {
    const [count, items] = await Promise.all([
      countOpenEscalations(),
      listOpenEscalations({ limit: 50 }),
    ]);
    return JSON.stringify({
      count,
      reviews: items.map((item) => ({
        id: item.id,
        transaction_id: item.transaction_id,
        source: item.source,
        kind: item.review_kind,
        status: item.status,
        severity: item.severity,
        summary: summarizeEscalation(item),
        created_at: item.created_at.toISOString(),
      })),
    });
  },
};

export const getEscalationTool: OperatorTool = {
  definition: {
    type: "function",
    function: {
      name: "get_review",
      description: "Get the current standard transaction and email context for a provider review.",
      parameters: {
        type: "object",
        properties: { review_id: { type: "string" } },
      },
    },
  },
  async execute(args, ctx) {
    const supplied = typeof args.review_id === "string" ? args.review_id : "";
    const id = ctx.mode === "autonomous" ? ctx.escalationId ?? "" : supplied || ctx.escalationId || "";
    if (!id) return JSON.stringify({ found: false, reason: "no_review_id" });
    const context = await loadEscalationContext(id);
    return context
      ? JSON.stringify({ found: true, context: summarizeEscalationContext(context) })
      : JSON.stringify({ found: false });
  },
};

export const replyToBuyerTool: OperatorTool = {
  definition: {
    type: "function",
    function: {
      name: "reply_to_buyer",
      description: "Reply only to the inbound sender bound to the current email review.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string" },
          body: { type: "string", description: "Plain-text reply body." },
        },
        required: ["subject", "body"],
      },
    },
  },
  async execute(args, ctx) {
    if (!ctx.escalationId) return JSON.stringify({ ok: false, reason: "no_review" });
    const context = await loadEscalationContext(ctx.escalationId);
    const inbound = context?.inbound;
    if (!context || !inbound) return JSON.stringify({ ok: false, reason: "no_inbound_email" });
    if (context.escalation.source !== "email_agent" || context.escalation.review_kind !== "email_triage") {
      return JSON.stringify({ ok: false, reason: "email_triage_review_required" });
    }
    if (!context.transaction || inbound.transaction_id !== context.transaction.id) {
      return JSON.stringify({ ok: false, reason: "authenticated_transaction_required" });
    }
    const from = context.service?.outbound_email_from;
    if (!from) return JSON.stringify({ ok: false, reason: "service_outbound_email_unset" });
    const subject = String(args.subject ?? "").trim().slice(0, 256);
    const body = String(args.body ?? "").trim().slice(0, 8_000);
    if (!subject || !body) return JSON.stringify({ ok: false, reason: "subject_and_body_required" });
    const replyTo = inbound.rfc_message_id ?? inbound.message_id;
    await sendEmail({
      serviceId: inbound.service_id ?? undefined,
      transactionId: inbound.transaction_id ?? undefined,
      inboundId: inbound.id,
      to: inbound.from_address,
      subject,
      bodyText: body,
      inReplyTo: replyTo,
      references: inbound.thread_root ? [inbound.thread_root, replyTo] : [replyTo],
      sentBy: "operator_agent",
      fromAddress: from,
      idempotencyKey: `operator-email-response:${inbound.id}`,
    });
    return JSON.stringify({ ok: true, replied_to_bound_inbound: true });
  },
};

export const resolveEscalationTool: OperatorTool = {
  definition: {
    type: "function",
    function: {
      name: "resolve_email_review",
      description: "Close the current email-triage review after replying or deciding no action is required.",
      parameters: {
        type: "object",
        properties: {
          disposition: { type: "string", enum: ["replied", "no-action"] },
          reasoning: { type: "string" },
        },
        required: ["disposition", "reasoning"],
      },
    },
  },
  async execute(args, ctx) {
    if (!ctx.escalationId) return JSON.stringify({ ok: false, reason: "no_review" });
    const row = await getEscalationById(ctx.escalationId);
    if (!row || row.source !== "email_agent" || row.review_kind !== "email_triage") {
      return JSON.stringify({ ok: false, reason: "email_triage_review_required" });
    }
    const disposition = String(args.disposition ?? "");
    if (disposition !== "replied" && disposition !== "no-action") {
      return JSON.stringify({ ok: false, reason: "invalid_disposition" });
    }
    const closed = await closeEscalation({
      id: row.id,
      status: "resolved",
      resolved_by: ctx.actor,
      response: String(args.reasoning ?? "").slice(0, 2_000),
      requireOutboundReply: disposition === "replied",
    });
    if (!closed) return JSON.stringify({ ok: false, reason: "review_not_open_or_reply_missing" });
    ctx.escalationClosed = true;
    await emitEvent({
      transactionId: row.transaction_id ?? undefined,
      source: "llm",
      type: "review.email_triage.resolved",
      actor: ctx.actor,
      message: "Email-triage review resolved through the operator conversation.",
      payload: { escalationId: row.id, disposition },
    });
    return JSON.stringify({ ok: true, status: "resolved", disposition });
  },
};

export const requestHumanReviewTool: OperatorTool = {
  definition: {
    type: "function",
    function: {
      name: "request_human_review",
      description: "Stop autonomous email triage and hand the bound review to a human.",
      parameters: {
        type: "object",
        properties: { recommendation: { type: "string" } },
        required: ["recommendation"],
      },
    },
  },
  async execute(args, ctx) {
    if (ctx.mode !== "autonomous" || !ctx.escalationId) {
      return JSON.stringify({ ok: false, reason: "autonomous_review_required" });
    }
    const row = await markEscalationAwaitingHuman({
      id: ctx.escalationId,
      agent_recommendation: String(args.recommendation ?? "").slice(0, 2_000),
    });
    if (!row) return JSON.stringify({ ok: false, reason: "review_not_in_agent_state" });
    ctx.humanReviewRequested = true;
    return JSON.stringify({ ok: true, status: "awaiting_human" });
  },
};

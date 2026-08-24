import { sendEmail } from "../../../email/postmarkOutbound.js";
import type { EmailAgentTool } from "./context.js";

export const replyToSender: EmailAgentTool = {
  definition: {
    type: "function",
    function: {
      name: "reply_to_sender",
      description:
        "Send a threaded reply back to whoever sent this email. Use to answer questions or ask for clarification.",
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
    await sendEmail({
      serviceId: ctx.serviceId,
      transactionId:
        ctx.authorization.kind === "authenticated"
          ? ctx.inbound.transaction_id ?? undefined
          : undefined,
      inboundId: ctx.inbound.id,
      to: ctx.inbound.from_address,
      subject: String(args.subject),
      bodyText: String(args.body),
      inReplyTo: ctx.inbound.rfc_message_id ?? ctx.inbound.message_id,
      references: ctx.inbound.thread_root
        ? [ctx.inbound.thread_root, ctx.inbound.rfc_message_id ?? ctx.inbound.message_id]
        : [ctx.inbound.rfc_message_id ?? ctx.inbound.message_id],
      sentBy: "email_agent",
      fromAddress: ctx.fromAddress,
      idempotencyKey: `email-agent-reply:${ctx.inbound.id}`,
    });
    return JSON.stringify({ ok: true });
  },
};

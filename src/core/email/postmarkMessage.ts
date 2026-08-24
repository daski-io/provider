import { createHash } from "node:crypto";
import { config } from "../config.js";
import { computeThreadRoot } from "./threading.js";

const POSTMARK_TEST_TOKEN = "POSTMARK_API_TEST";
const BASE_MAINNET_CHAIN_ID = 8453;

export interface SendEmailArgs {
  serviceId?: string | null;
  transactionId?: string | null;
  inboundId?: string | null;
  customerId?: string | null;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  inReplyTo?: string | null;
  references?: string[];
  messageStream?: string;
  sentBy: "email_agent" | "operator_agent" | "admin" | "system";
  fromAddress: string;
  idempotencyKey?: string;
}

export function preparePostmarkMessage(args: SendEmailArgs) {
  const testMode = config.POSTMARK_TEST_MODE
    ?? config.CHAIN_ID !== BASE_MAINNET_CHAIN_ID;
  const token = testMode ? POSTMARK_TEST_TOKEN : config.POSTMARK_SERVER_TOKEN;
  if (!token) {
    throw new Error(
      "POSTMARK_SERVER_TOKEN is not set — outbound email is disabled in this deployment.",
    );
  }
  if (args.to.length > 320
    || args.subject.length > config.POSTMARK_INBOUND_MAX_SUBJECT_CHARS
    || args.bodyText.length > config.POSTMARK_INBOUND_MAX_BODY_CHARS
    || (args.bodyHtml?.length ?? 0) > config.POSTMARK_INBOUND_MAX_BODY_CHARS) {
    throw new Error("outbound email exceeds configured size limits");
  }
  const threadRoot = computeThreadRoot({
    messageId: "",
    inReplyTo: args.inReplyTo ?? null,
    references: args.references ?? [],
  });
  const logicalKey = args.idempotencyKey
    ?? (args.inboundId ? `${args.sentBy}:inbound:${args.inboundId}` : null);
  const material = logicalKey
    ? `logical-email:v1\0${logicalKey}`
    : JSON.stringify({
      version: 1,
      sentBy: args.sentBy,
      inboundId: args.inboundId ?? null,
      transactionId: args.transactionId ?? null,
      serviceId: args.serviceId ?? null,
      from: args.fromAddress,
      to: args.to,
      subject: args.subject,
      bodyText: args.bodyText,
      bodyHtml: args.bodyHtml ?? null,
      inReplyTo: args.inReplyTo ?? null,
      references: args.references ?? [],
      messageStream: args.messageStream ?? "outbound",
    });
  const idempotencyKey = createHash("sha256").update(material).digest("hex");
  const headers: Array<{ Name: string; Value: string }> = [];
  if (args.inReplyTo) headers.push({ Name: "In-Reply-To", Value: args.inReplyTo });
  if (args.references?.length) {
    headers.push({ Name: "References", Value: args.references.join(" ") });
  }
  return {
    token,
    testMode,
    insert: {
      from_address: args.fromAddress,
      to_address: args.to,
      subject: args.subject,
      body_text: args.bodyText,
      body_html: args.bodyHtml ?? null,
      in_reply_to: args.inReplyTo ?? null,
      thread_root: threadRoot || null,
      customer_id: args.customerId ?? null,
      service_id: args.serviceId ?? null,
      transaction_id: args.transactionId ?? null,
      inbound_id: args.inboundId ?? null,
      sent_by: args.sentBy,
      idempotency_key: idempotencyKey,
    },
    request: {
      From: args.fromAddress,
      To: args.to,
      Subject: args.subject,
      TextBody: args.bodyText,
      ...(args.bodyHtml ? { HtmlBody: args.bodyHtml } : {}),
      MessageStream: args.messageStream ?? "outbound",
      Headers: headers,
    },
  };
}

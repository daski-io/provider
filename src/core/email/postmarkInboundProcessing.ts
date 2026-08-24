import { config } from "../config.js";
import {
  insertInboundEmail,
  updateInboundEmailClassification,
  updateInboundProcessing,
} from "../db/queries/emails.js";
import { getServiceByInboundEmail } from "../db/queries/services.js";
import { emitEvent } from "../events/emitter.js";
import { shouldAutoFilter } from "./preFilter.js";
import { enqueueEmailIngress, requeueFailedEmailIngress } from "./postmarkIngressQueue.js";
import { findInboundInterceptor } from "./postmarkRouting.js";
import { computeThreadRoot, normalizeMessageId } from "./threading.js";

interface PostmarkInboundPayload {
  MessageID?: string;
  From?: string;
  To?: string;
  OriginalRecipient?: string;
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  Headers?: Array<{ Name: string; Value: string }>;
}

export interface PostmarkIngressResult {
  status: number;
  body: { ok: boolean; reason?: string; inboundId?: string; duplicate?: boolean };
}

function header(payload: PostmarkInboundPayload, name: string): string | null {
  return payload.Headers
    ?.find((item) => item.Name.toLowerCase() === name.toLowerCase())
    ?.Value.trim() || null;
}

function references(payload: PostmarkInboundPayload): string[] {
  return (header(payload, "references") ?? "").split(/\s+/).filter(Boolean);
}

function headersObject(payload: PostmarkInboundPayload): Record<string, string> {
  return Object.fromEntries((payload.Headers ?? []).map((item) => [item.Name, item.Value]));
}

function validatePayload(payload: PostmarkInboundPayload): PostmarkIngressResult | null {
  if (!payload.MessageID || !payload.From || !payload.To) {
    return { status: 400, body: { ok: false, reason: "missing_fields" } };
  }
  const tooLarge = payload.MessageID.length > 255
    || payload.From.length > 320
    || payload.To.length > 2_048
    || (payload.Subject?.length ?? 0) > config.POSTMARK_INBOUND_MAX_SUBJECT_CHARS
    || (payload.TextBody?.length ?? 0) > config.POSTMARK_INBOUND_MAX_BODY_CHARS
    || (payload.HtmlBody?.length ?? 0) > config.POSTMARK_INBOUND_MAX_BODY_CHARS
    || (payload.Headers?.length ?? 0) > config.POSTMARK_INBOUND_MAX_HEADERS
    || (payload.Headers ?? []).some((item) => item.Name.length > 100 || item.Value.length > 2_000);
  return tooLarge ? { status: 413, body: { ok: false, reason: "message_too_large" } } : null;
}

export async function processPostmarkInbound(payloadValue: unknown): Promise<PostmarkIngressResult> {
  const payload = (payloadValue ?? {}) as PostmarkInboundPayload;
  const invalid = validatePayload(payload);
  if (invalid) return invalid;
  const messageId = payload.MessageID!;
  const from = payload.From!;
  const recipient = (payload.OriginalRecipient ?? payload.To!).toLowerCase();
  const routing = await findInboundInterceptor(recipient);
  const interceptor = routing.interceptor;
  const service = routing.failed
    ? null
    : interceptor?.serviceRow ?? await getServiceByInboundEmail(recipient);
  const rfcMessageId = normalizeMessageId(header(payload, "message-id") ?? messageId);
  const inReplyTo = header(payload, "in-reply-to");
  const threadRoot = computeThreadRoot({
    messageId: rfcMessageId,
    inReplyTo,
    references: references(payload),
  });
  const filter = interceptor || routing.failed
    ? { filter: false as const, reason: null }
    : await shouldAutoFilter({ Headers: payload.Headers, Subject: payload.Subject, threadRoot });
  const mode = routing.failed || filter.filter || !service
    ? null
    : interceptor ? "interceptor" as const : "email-agent" as const;
  const { row, inserted } = await insertInboundEmail({
    message_id: messageId,
    rfc_message_id: rfcMessageId,
    from_address: from,
    to_address: recipient,
    subject: payload.Subject ?? null,
    body_text: payload.TextBody ?? null,
    body_html: payload.HtmlBody ?? null,
    headers: headersObject(payload),
    in_reply_to: inReplyTo,
    thread_root: threadRoot,
    service_id: service?.id ?? null,
    customer_id: null,
    classification: routing.failed ? "unknown" : filter.filter ? "auto_filtered" : null,
    classification_reason: routing.failed
      ? "inbound routing matcher failed; human review required"
      : filter.reason ?? null,
    processing_mode: mode,
    processing_service_slug: service?.slug ?? null,
  });
  if (!inserted) {
    if (routing.failed) {
      await updateInboundProcessing({
        id: row.id,
        status: "dead_letter",
        error: "inbound routing matcher failed",
      });
    } else if (mode && service) {
      await requeueFailedEmailIngress(row.id, mode, service.slug);
    }
    return { status: 200, body: { ok: true, inboundId: row.id, duplicate: true } };
  }
  if (routing.failed) {
    await updateInboundProcessing({
      id: row.id,
      status: "dead_letter",
      error: "inbound routing matcher failed",
    });
    await emitEvent({
      source: "email",
      severity: "error",
      type: "email.routing_matcher_failed",
      message: "Inbound email routing failed closed and requires human review.",
      payload: { inboundId: row.id },
    });
  } else if (filter.filter) {
    await updateInboundProcessing({ id: row.id, status: "completed" });
    await emitEvent({
      serviceId: service?.id,
      source: "email",
      severity: "debug",
      type: "email.auto_filtered",
      message: "Inbound email was filtered by deterministic policy.",
      payload: { inboundId: row.id },
    });
  } else if (!service) {
    await updateInboundEmailClassification({
      id: row.id,
      classification: "unrouted",
      reason: "no configured service matched the recipient",
    });
    await updateInboundProcessing({ id: row.id, status: "completed" });
    await emitEvent({
      source: "email",
      severity: "warn",
      type: "email.unrouted",
      message: "Inbound email did not match a configured service recipient.",
      payload: { inboundId: row.id },
    });
  } else {
    await emitEvent({
      serviceId: service.id,
      source: "email",
      type: interceptor ? "email.intercepted" : "email.received",
      message: interceptor
        ? `Inbound email routed to ${interceptor.module.manifest.slug} handler.`
        : "Authenticated inbound email accepted for processing.",
      payload: { inboundId: row.id },
    });
    await enqueueEmailIngress(
      row.id,
      mode!,
      interceptor?.module.manifest.slug ?? service.slug,
    );
  }
  return { status: 200, body: { ok: true, inboundId: row.id } };
}

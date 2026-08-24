import { updateOutboundDeliveryStatus } from "../db/queries/emails.js";
import { emitEvent } from "../events/emitter.js";
import type { SendEmailArgs } from "./postmarkMessage.js";

function eventContext(args: SendEmailArgs) {
  return {
    serviceId: args.serviceId ?? undefined,
    transactionId: args.transactionId ?? undefined,
  };
}

export async function recordUnknownOutcome(
  rowId: string,
  args: SendEmailArgs,
  status?: number,
): Promise<void> {
  await updateOutboundDeliveryStatus({ id: rowId, status: "outcome_unknown" });
  await emitEvent({
    ...eventContext(args),
    source: "email",
    severity: "error",
    type: "email.outcome_unknown",
    message: status === undefined
      ? "Postmark send outcome is unknown; automatic resend is blocked."
      : "Postmark returned success without a message identifier; automatic resend is blocked.",
    payload: { outboundId: rowId, ...(status === undefined ? {} : { status }) },
    mandatory: true,
  });
}

export async function recordFailedOutcome(
  rowId: string,
  args: SendEmailArgs,
  status: number,
): Promise<void> {
  await updateOutboundDeliveryStatus({ id: rowId, status: "send_failed" });
  await emitEvent({
    ...eventContext(args),
    source: "email",
    severity: "error",
    type: "email.send_failed",
    message: `Postmark send returned HTTP ${status}.`,
    payload: { outboundId: rowId, status },
  });
}

export async function recordAcceptedOutcome(
  rowId: string,
  args: SendEmailArgs,
  messageId: string,
  testMode: boolean,
): Promise<void> {
  await emitEvent({
    ...eventContext(args),
    source: "email",
    type: "email.sent",
    message: `Outbound email accepted by Postmark${testMode ? " test mode" : ""}.`,
    payload: { outboundId: rowId, postmarkMessageId: messageId, testMode },
  });
}

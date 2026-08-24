import {
  updateOutboundDeliveryStatus,
} from "../db/queries/emails.js";
import { emitEvent } from "../events/emitter.js";

export async function processPostmarkDelivery(payload: unknown): Promise<void> {
  const delivery = (payload ?? {}) as {
    MessageID?: string;
    RecordType?: string;
  };
  if (!delivery.MessageID) return;
  const status = (delivery.RecordType ?? "delivery").toLowerCase();
  await updateOutboundDeliveryStatus({
    message_id: delivery.MessageID,
    status,
    payload: { recordType: delivery.RecordType ?? "delivery" },
  });
  await emitEvent({
    source: "email",
    severity: status === "bounce" || status === "spamcomplaint" ? "warn" : "info",
    type: `email.${status}`,
    message: `Postmark delivery status changed to ${status}.`,
    payload: { messageId: delivery.MessageID, status },
  });
}

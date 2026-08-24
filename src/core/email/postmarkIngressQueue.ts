import { enqueueDurableJob, requeueDeadLetter } from "../db/queries/durableJobs.js";
import { updateInboundProcessing } from "../db/queries/emails.js";
import { EMAIL_INGRESS_QUEUE } from "./inboundWorker.js";

export type EmailIngressMode = "interceptor" | "email-agent";

export async function enqueueEmailIngress(
  inboundId: string,
  mode: EmailIngressMode,
  serviceSlug: string,
): Promise<void> {
  await enqueueDurableJob({
    queue: EMAIL_INGRESS_QUEUE,
    idempotencyKey: inboundId,
    payload: { inboundId, mode, serviceSlug },
    maxAttempts: 8,
  });
  await updateInboundProcessing({ id: inboundId, status: "queued" });
}

export async function requeueFailedEmailIngress(
  inboundId: string,
  mode: EmailIngressMode,
  serviceSlug: string,
): Promise<void> {
  await requeueDeadLetter(EMAIL_INGRESS_QUEUE, inboundId);
  await enqueueEmailIngress(inboundId, mode, serviceSlug);
}

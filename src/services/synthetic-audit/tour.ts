import type {
  ExternalJobAdapter,
  ExternalJobContext,
  JsonRecord,
  ServiceResult,
} from "../../core/serviceRegistry/types.js";
import { compileProviderSchema } from "../../core/standardRail/schema.js";
import { judgeServiceResult } from "../../core/standardRail/serviceResult.js";
import { AUDIT_FULFILLMENT_SECONDS, AUDIT_IDEMPOTENCY_RETENTION_SECONDS } from "./config.js";
import { createSyntheticAuditService } from "./index.js";
import { FakeAuditUpstream } from "./upstream.js";

export interface TourStep {
  /** Fake hours since the order was accepted. */
  hour: number;
  call: "start" | "recoverStart" | "poll";
  outcome: string;
}

const START = 1_800_000_000;

/**
 * An offline walk through one synthetic audit with a fake clock and the
 * in-memory product: no wallet, database, chain, gateway or real product.
 * It plays the worker's part in a few lines so the adapter's calls and
 * outcomes are visible (a lost start response, recovery by the order key,
 * eight hours of pending polls, the report judged against the published
 * result contract). The durable scheduler itself (leases, journal, restarts,
 * deadlines) is exercised by the PostgreSQL suites.
 */
export async function runSyntheticAuditTour(description: string): Promise<{
  steps: TourStep[];
  submissions: number;
  result: ServiceResult;
}> {
  let now = START;
  const upstream = new FakeAuditUpstream(() => now);
  const service = createSyntheticAuditService({ chainId: 84532, clock: () => now, upstream });
  const adapter = service.adapter as ExternalJobAdapter;
  const context: ExternalJobContext = {
    taskId: "offline-tour",
    orderId: "offline-tour",
    payer: "0x0000000000000000000000000000000000000001",
    serviceSlug: service.manifest.slug,
    skillId: "audit",
    // The audit buys nothing from a supplier: its quotes record no ceiling.
    supplierCostCeiling: null,
    idempotencyKey: "00000000-0000-8000-8000-000000000001",
    acceptedAt: START,
    fulfillmentDeadline: START + AUDIT_FULFILLMENT_SECONDS,
    firstStartAttemptAt: START,
    idempotencyValidBefore: START + AUDIT_IDEMPOTENCY_RETENTION_SECONDS,
    signal: new AbortController().signal,
  };
  const steps: TourStep[] = [];
  const hour = () => Math.round(((now - START) / 3_600) * 10) / 10;
  const input = { description };

  // The product creates the audit, but its answer is lost on the way back.
  upstream.loseNextSubmitResponse = true;
  await adapter.start(context, input).then(
    () => steps.push({ hour: hour(), call: "start", outcome: "answered" }),
    () => steps.push({ hour: hour(), call: "start", outcome: "no answer: ambiguous, core reconciles" }),
  );
  const recovered = await adapter.recoverStart(context, input);
  if (recovered.kind !== "accepted") throw new Error("the tour expected recovery by the order key");
  steps.push({ hour: hour(), call: "recoverStart", outcome: `original job found by its order key (${String(recovered.job.jobId)})` });
  const job: JsonRecord = recovered.job;
  for (;;) {
    const polled = await adapter.poll(context, job);
    if (polled.kind === "pending") {
      steps.push({ hour: hour(), call: "poll", outcome: "pending" });
      now += polled.pollAfterSeconds ?? 60;
      continue;
    }
    if (polled.kind !== "terminal") throw new Error("the tour expected a report");
    steps.push({ hour: hour(), call: "poll", outcome: `terminal ${polled.result.status}` });
    const contract = { validate: compileProviderSchema(service.skills[0]!.resultSchema), failureCodes: new Set(service.failureCodes) };
    const judged = judgeServiceResult(polled.result, contract);
    if (judged.kind !== "frozen") throw new Error("the report does not match the published result contract");
    return { steps, submissions: upstream.submissions, result: judged.result };
  }
}

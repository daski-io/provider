import type {
  ExternalJobAdapter,
  ExternalJobContext,
  JsonRecord,
  PollOutcome,
  ServiceResult,
  StartOutcome,
  StartRecovery,
} from "../../core/serviceRegistry/types.js";
import {
  AUDIT_ADAPTER_VERSION,
  AUDIT_IDEMPOTENCY_RETENTION_SECONDS,
  AUDIT_POLL_AFTER_SECONDS,
  AUDIT_SKILL_ID,
} from "./config.js";
import type { AuditJob, AuditReport, AuditUpstream } from "./upstream.js";
import { parseDescription, parseJobReference } from "./validation.js";

/** Leave room for the product to see a replayed key before its guarantee ends. */
const REPLAY_MARGIN_SECONDS = 300;

const reference = (job: AuditJob): JsonRecord => ({ v: 1, jobId: job.jobId, reportUrl: job.reportUrl });

/** The product's report as the complete completed result the skill contract declares. */
export function mapReport(report: AuditReport): ServiceResult {
  return {
    status: "completed",
    message: "Synthetic audit completed.",
    artifacts: [{
      name: "audit_report",
      mimeType: "application/json",
      data: { summary: report.summary, findings: report.findings },
    }],
  };
}

/**
 * The synthetic audit as an external job. Daski's verified payment is the
 * purchase, so `start` asks the product's own creation operation to audit
 * the order (keyed by core's stable idempotency key), never a public paid
 * endpoint. Any failure to learn the start's outcome is thrown or reported
 * ambiguous, and core reconciles it. `recoverStart` is read-only: it finds
 * the original job by its order key, the product's authoritative lookup,
 * or, when the lookup proves nothing, allows a same-key replay only inside
 * the product's documented 24-hour guarantee. `poll` is read-only too.
 */
export class SyntheticAuditAdapter implements ExternalJobAdapter {
  readonly mode = "external-job" as const;
  readonly version = AUDIT_ADAPTER_VERSION;
  readonly idempotencyRetentionSeconds = AUDIT_IDEMPOTENCY_RETENTION_SECONDS;

  constructor(private readonly upstream: AuditUpstream, private readonly clock: () => number) {}

  async start(context: ExternalJobContext, input: JsonRecord): Promise<StartOutcome> {
    // Refusals decided before any product call are definitive.
    if (context.skillId !== AUDIT_SKILL_ID) return { kind: "terminal", result: { status: "failed", errorCode: "unknown_skill" } };
    let description: string;
    try {
      description = parseDescription(input.description);
    } catch {
      return { kind: "terminal", result: { status: "failed", errorCode: "invalid_input" } };
    }
    const job = await this.upstream.submit({ orderKey: context.idempotencyKey, description }, context.signal);
    return { kind: "accepted", job: reference(job), pollAfterSeconds: AUDIT_POLL_AFTER_SECONDS };
  }

  async recoverStart(context: ExternalJobContext): Promise<StartRecovery> {
    let found: AuditJob | null;
    try {
      found = await this.upstream.lookupByOrderKey(context.idempotencyKey, context.signal);
    } catch {
      return { kind: "unknown", issue: { code: "upstream_unavailable" } };
    }
    if (found) return { kind: "accepted", job: reference(found), pollAfterSeconds: AUDIT_POLL_AFTER_SECONDS };
    // The lookup is authoritative for jobs it has created, but a lost
    // request could still arrive: only a same-key replay inside the
    // product's guarantee is safe, and core rechecks the horizon.
    const horizon = context.idempotencyValidBefore;
    if (horizon !== null && this.clock() + REPLAY_MARGIN_SECONDS < horizon) {
      return { kind: "safe-to-start", basis: "idempotent-replay" };
    }
    return { kind: "unknown" };
  }

  async poll(context: ExternalJobContext, job: JsonRecord): Promise<PollOutcome> {
    const parsed = parseJobReference(job);
    if (!parsed) return { kind: "retry", issue: { code: "adapter_fault" } };
    const state = await this.upstream.report(parsed.jobId, parsed.token, context.signal);
    switch (state.state) {
      case "running": return { kind: "pending", pollAfterSeconds: AUDIT_POLL_AFTER_SECONDS };
      case "done": return { kind: "terminal", result: mapReport(state.report) };
      case "rejected": return { kind: "terminal", result: { status: "failed", errorCode: "audit_rejected" } };
      // A job the product cannot find right now proves no failure.
      case "missing": return { kind: "retry", issue: { code: "upstream_unavailable" } };
    }
  }
}

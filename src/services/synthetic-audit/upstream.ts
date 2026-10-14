import { createHash, randomUUID } from "node:crypto";
import {
  AUDIT_IDEMPOTENCY_RETENTION_SECONDS,
  AUDIT_REVIEWED_ENDPOINT,
  AUDIT_RUNTIME_SECONDS,
} from "./config.js";

/** One audit job as the product's API describes it. */
export interface AuditJob {
  jobId: string;
  /** A bearer URL: whoever holds it can read the report. */
  reportUrl: string;
}

export interface AuditReport {
  summary: string;
  findings: Array<{ severity: "low" | "medium" | "high"; title: string }>;
}

export type ReportState =
  | { state: "running" }
  | { state: "done"; report: AuditReport }
  | { state: "rejected" }
  | { state: "missing" };

/** The product operations the adapter uses; a real integration implements them over HTTP. */
export interface AuditUpstream {
  /** Create the audit; idempotent per order key for the documented retention. */
  submit(args: { orderKey: string; description: string }, signal: AbortSignal): Promise<AuditJob>;
  /** Authoritative, strongly consistent lookup of the job created for an order key. */
  lookupByOrderKey(orderKey: string, signal: AbortSignal): Promise<AuditJob | null>;
  /** Read one report through its bearer token. */
  report(jobId: string, token: string, signal: AbortSignal): Promise<ReportState>;
}

/** A transient product fault: the call's outcome is unknown. */
export class AuditUnavailableError extends Error {
  constructor() {
    super("synthetic audit product is unavailable");
    this.name = "AuditUnavailableError";
  }
}

interface StoredJob extends AuditJob {
  orderKey: string;
  token: string;
  description: string;
  createdAt: number;
}

/**
 * An in-memory fake of the synthetic audit product: no network, no secret,
 * a test-controlled clock. Submissions are idempotent per order key for 24
 * hours; an audit takes eight hours; a description containing "reject" is
 * refused definitively. Tests can make it lose the next submit response
 * (the job is created, the caller sees a failure), lag its eventually
 * consistent search, or fail its lookups.
 */
export class FakeAuditUpstream implements AuditUpstream {
  private readonly jobs = new Map<string, StoredJob>();
  submissions = 0;
  loseNextSubmitResponse = false;
  lookupsUnavailable = false;

  constructor(readonly clock: () => number) {}

  async submit(args: { orderKey: string; description: string }): Promise<AuditJob> {
    const existing = [...this.jobs.values()].find((job) => job.orderKey === args.orderKey
      && this.clock() < job.createdAt + AUDIT_IDEMPOTENCY_RETENTION_SECONDS);
    const job = existing ?? this.create(args);
    if (this.loseNextSubmitResponse) {
      this.loseNextSubmitResponse = false;
      throw new AuditUnavailableError();
    }
    return { jobId: job.jobId, reportUrl: job.reportUrl };
  }

  async lookupByOrderKey(orderKey: string): Promise<AuditJob | null> {
    if (this.lookupsUnavailable) throw new AuditUnavailableError();
    const job = [...this.jobs.values()].find((candidate) => candidate.orderKey === orderKey);
    return job ? { jobId: job.jobId, reportUrl: job.reportUrl } : null;
  }

  /** An eventually consistent listing: jobs younger than `lagSeconds` are not in it yet. */
  searchRecent(lagSeconds: number): AuditJob[] {
    return [...this.jobs.values()].filter((job) => this.clock() - job.createdAt >= lagSeconds);
  }

  async report(jobId: string, token: string): Promise<ReportState> {
    const job = this.jobs.get(jobId);
    if (!job || job.token !== token) return { state: "missing" };
    if (job.description.toLowerCase().includes("reject")) return { state: "rejected" };
    if (this.clock() < job.createdAt + AUDIT_RUNTIME_SECONDS) return { state: "running" };
    const digest = createHash("sha256").update(job.description).digest("hex").slice(0, 8);
    return {
      state: "done",
      report: {
        summary: `Synthetic audit ${digest} found 2 issues.`,
        findings: [
          { severity: "medium", title: "Synthetic finding A" },
          { severity: "low", title: "Synthetic finding B" },
        ],
      },
    };
  }

  private create(args: { orderKey: string; description: string }): StoredJob {
    this.submissions += 1;
    const jobId = `aud-${randomUUID()}`;
    const token = randomUUID().replaceAll("-", "");
    const job: StoredJob = {
      jobId,
      token,
      orderKey: args.orderKey,
      description: args.description,
      createdAt: this.clock(),
      reportUrl: `${AUDIT_REVIEWED_ENDPOINT}/jobs/${jobId}/report?token=${token}`,
    };
    this.jobs.set(jobId, job);
    return job;
  }
}

import { beforeEach, describe, expect, it } from "vitest";
import { boundedJobReference } from "../../../core/externalJobs/jobCodec.js";
import { clearServicesForTests, registerService } from "../../../core/serviceRegistry/registry.js";
import type { ExternalJobAdapter, ExternalJobContext } from "../../../core/serviceRegistry/types.js";
import { compileProviderSchema } from "../../../core/standardRail/schema.js";
import { judgeServiceResult } from "../../../core/standardRail/serviceResult.js";
import { AUDIT_IDEMPOTENCY_RETENTION_SECONDS, AUDIT_RUNTIME_SECONDS } from "../config.js";
import { createSyntheticAuditService } from "../index.js";
import { runSyntheticAuditTour } from "../tour.js";
import { FakeAuditUpstream } from "../upstream.js";
import { parseJobReference } from "../validation.js";

const START = 1_800_000_000;

describe("synthetic audit external-job example", () => {
  let now: number;
  let upstream: FakeAuditUpstream;
  let adapter: ExternalJobAdapter;
  const service = () => createSyntheticAuditService({ chainId: 84532, clock: () => now, upstream });
  const context = (overrides: Partial<ExternalJobContext> = {}): ExternalJobContext => ({
    taskId: "task-1", orderId: "ord-1", payer: "0x0000000000000000000000000000000000000001",
    serviceSlug: "synthetic-audit", skillId: "audit", idempotencyKey: "00000000-0000-8000-8000-0000000000a1",
    acceptedAt: START, fulfillmentDeadline: START + 43_200, firstStartAttemptAt: START,
    idempotencyValidBefore: START + AUDIT_IDEMPOTENCY_RETENTION_SECONDS, signal: new AbortController().signal,
    ...overrides,
  });
  const input = { description: "Audit the sample onboarding flow" };

  beforeEach(() => {
    now = START;
    upstream = new FakeAuditUpstream(() => now);
    adapter = service().adapter as ExternalJobAdapter;
    clearServicesForTests();
  });

  it("registers as an external-job service with a 12-hour window, and never on Base mainnet", () => {
    registerService(service());
    expect(adapter).toMatchObject({ mode: "external-job", version: "audit-v1", idempotencyRetentionSeconds: 86_400 });
    expect(service().skills[0]!.deadlines).toEqual({ dispatchSeconds: 300, fulfillmentSeconds: 43_200 });
    expect(() => createSyntheticAuditService({ chainId: 8453 })).toThrow(/Base mainnet/);
  });

  it("submits under core's key and hands back a bounded reference core accepts", async () => {
    const started = await adapter.start(context(), input);
    expect(started).toMatchObject({ kind: "accepted", pollAfterSeconds: 1_800 });
    const job = (started as { job: Record<string, unknown> }).job;
    expect(boundedJobReference(job)).toEqual(job);
    expect(parseJobReference(job)).toMatchObject({ jobId: job.jobId });
    // The same key inside the product's guarantee is the same audit.
    await adapter.start(context(), input);
    expect(upstream.submissions).toBe(1);
  });

  it("recovers a lost start response by the order key without a second audit", async () => {
    upstream.loseNextSubmitResponse = true;
    await expect(adapter.start(context(), input)).rejects.toThrow();
    const recovered = await adapter.recoverStart(context(), input);
    expect(recovered).toMatchObject({ kind: "accepted" });
    expect(upstream.submissions).toBe(1);
  });

  it("never treats an empty eventual search as absence, and replays only inside the guarantee", async () => {
    upstream.loseNextSubmitResponse = true;
    await adapter.start(context(), input).catch(() => undefined);
    // The eventually consistent listing does not show the job yet; the
    // adapter never relies on it.
    expect(upstream.searchRecent(60)).toEqual([]);
    upstream.lookupsUnavailable = true;
    expect(await adapter.recoverStart(context(), input)).toMatchObject({ kind: "unknown" });
    upstream.lookupsUnavailable = false;
    expect(await adapter.recoverStart(context({ idempotencyKey: "00000000-0000-8000-8000-0000000000b2" }), input))
      .toEqual({ kind: "safe-to-start", basis: "idempotent-replay" });
    now = START + AUDIT_IDEMPOTENCY_RETENTION_SECONDS - 60;
    expect(await adapter.recoverStart(context({ idempotencyKey: "00000000-0000-8000-8000-0000000000b2" }), input))
      .toEqual({ kind: "unknown" });
    expect(await adapter.recoverStart(context({
      idempotencyKey: "00000000-0000-8000-8000-0000000000b2", idempotencyValidBefore: null,
    }), input)).toEqual({ kind: "unknown" });
  });

  it("polls an eight-hour audit and maps its report to the published complete result", async () => {
    const started = await adapter.start(context(), input) as { job: Record<string, unknown> };
    expect(await adapter.poll(context(), started.job)).toEqual({ kind: "pending", pollAfterSeconds: 1_800 });
    now = START + AUDIT_RUNTIME_SECONDS;
    const done = await adapter.poll(context(), started.job);
    expect(done.kind).toBe("terminal");
    const module = service();
    const judged = judgeServiceResult((done as { result: unknown }).result, {
      validate: compileProviderSchema(module.skills[0]!.resultSchema),
      failureCodes: new Set(module.failureCodes),
    });
    expect(judged).toMatchObject({ kind: "frozen", result: { status: "completed" } });
  });

  it("follows only a report URL under the reviewed endpoint, and takes no URL from the buyer", async () => {
    const started = await adapter.start(context(), input) as unknown as { job: { jobId: string; reportUrl: string; v: number } };
    const url = new URL(started.job.reportUrl);
    const token = url.searchParams.get("token");
    for (const reportUrl of [
      started.job.reportUrl.replace("https://audit.example", "https://evil.example"),
      started.job.reportUrl.replace("https:", "http:"),
      started.job.reportUrl.replace("https://", "https://user:pass@"),
      started.job.reportUrl.replace("audit.example", "audit.example:8443"),
      `${started.job.reportUrl}&redirect=https://evil.example`,
      started.job.reportUrl.replace("/report", "/../../admin"),
      `${started.job.reportUrl}#fragment`,
      `https://audit.example/v1/jobs/${started.job.jobId}/report`,
      `https://127.0.0.1/v1/jobs/${started.job.jobId}/report?token=${token}`,
    ]) {
      expect(await adapter.poll(context(), { ...started.job, reportUrl }), reportUrl)
        .toEqual({ kind: "retry", issue: { code: "adapter_fault" } });
    }
    expect(await adapter.poll(context(), { ...started.job, extra: true })).toMatchObject({ kind: "retry" });
    const validate = compileProviderSchema(service().skills[0]!.inputSchema);
    expect(validate({ description: "x", resultUrl: "https://evil.example", apiKey: "k" })).toBe(false);
  });

  it("maps a definitive rejection to a reviewed code and a missing job to a retry", async () => {
    const rejected = await adapter.start(context(), { description: "please reject this" }) as { job: Record<string, unknown> };
    expect(await adapter.poll(context(), rejected.job))
      .toEqual({ kind: "terminal", result: { status: "failed", errorCode: "audit_rejected" } });
    expect(await adapter.poll(context(), { ...rejected.job, reportUrl: String(rejected.job.reportUrl).replace(/token=\w+/, `token=${"0".repeat(32)}`) }))
      .toEqual({ kind: "retry", issue: { code: "upstream_unavailable" } });
    expect(await adapter.start(context(), { description: "<script>x</script>" }))
      .toEqual({ kind: "terminal", result: { status: "failed", errorCode: "invalid_input" } });
    expect(upstream.submissions).toBe(1);
  });

  it("declines before payment a description the audit cannot take", async () => {
    const module = service();
    await expect(module.requestReadiness!({
      skillId: "audit", input: { description: "<form>" }, payer: null, signal: new AbortController().signal,
    })).resolves.toMatchObject({ ready: false, fieldErrors: [{ path: "description" }] });
    await expect(module.requestReadiness!({
      skillId: "audit", input, payer: null, signal: new AbortController().signal,
    })).resolves.toEqual({ ready: true });
  });

  it("tours one audit offline: a lost answer, recovery by key, eight hours of polls, one report", async () => {
    const tour = await runSyntheticAuditTour("Audit the sample onboarding flow");
    expect(tour.submissions).toBe(1);
    expect(tour.steps.map((step) => step.call).slice(0, 2)).toEqual(["start", "recoverStart"]);
    expect(tour.steps.at(-1)).toEqual({ hour: 8, call: "poll", outcome: "terminal completed" });
    expect(tour.steps.filter((step) => step.outcome === "pending")).toHaveLength(16);
    expect(JSON.stringify(tour)).not.toContain("token=");
    expect(tour.result).toMatchObject({ status: "completed", artifacts: [{ name: "audit_report" }] });
  });
});

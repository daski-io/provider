import { describe, expect, it } from "vitest";
import {
  countLines,
  findEvaluationReferences,
  findRoutingContradictions,
  findUnknownAdapterReferences,
  readAdapterApi,
  SKILL_MAX_LINES,
} from "../scripts/skill-rules.mjs";

const api = readAdapterApi(process.cwd());

// S05: the docs and skill checks catch routing statements that contradict
// the three paths and examples naming adapter members or outcomes the
// checked-out source does not declare.
describe("skill and documentation consistency rules", () => {
  it("reads the adapter API from the checked-out source", () => {
    expect([...api.kinds].sort()).toEqual(
      ["accepted", "ambiguous", "pending", "retry", "safe-to-start", "terminal", "unknown"],
    );
    expect([...api.bases].sort()).toEqual(["authoritative-absence", "idempotent-replay"]);
    expect([...api.modes].sort()).toEqual(["external-job", "sync"]);
    expect([...api.issueCodes].sort()).toEqual(
      ["adapter_fault", "invalid_response", "rate_limited", "timeout", "upstream_unavailable"],
    );
    expect([...api.members.get("adapter")!]).toEqual(expect.arrayContaining(["execute", "start", "recoverStart", "poll"]));
    expect(api.members.get("module")!.has("previousExternalJobAdapters")).toBe(true);
    expect(api.members.get("context")!.has("idempotencyValidBefore")).toBe(true);
    expect([...api.outboundHelpers]).toEqual(
      expect.arrayContaining(["boundedFetch", "pinnedHttpRequest", "reviewedEndpoint", "appendReviewedOperation"]),
    );
    expect(api.outboundHelpers.has("PinnedHttpClient")).toBe(false);
  });

  it("flags references to members and outcomes the API does not declare", () => {
    const text = [
      "Call `adapter.cancel(context)` and read `context.jobUrl`.",
      "```ts",
      'return { kind: "running" };',
      'return { kind: "safe-to-start", basis: "eventual-search" };',
      'const adapter = { mode: "async" };',
      'return { kind: "retry", issue: { code: "network" } };',
      "ServiceModule.retryFailedOrder();",
      "const client = new BoundedHttpClient();",
      "```",
      "Use `boundedFetch`, `PinnedHttpClient`, or `reviewedEndpoint` for product HTTP.",
    ].join("\n");
    expect(findUnknownAdapterReferences(text, api).sort()).toEqual([
      '"async" is not a declared adapter mode',
      '"eventual-search" is not a declared safe-to-start basis',
      '"network" is not a declared call-issue code',
      '"running" is not a declared outcome kind',
      "BoundedHttpClient is not an exported outbound HTTP helper",
      "PinnedHttpClient is not an exported outbound HTTP helper",
      "ServiceModule.retryFailedOrder is not a declared member",
      "adapter.cancel is not a declared member",
      "cancel(context, ...) is not a declared adapter hook",
      "context.jobUrl is not a declared member",
    ]);
  });

  it("accepts the declared API and ignores file names", () => {
    const text = [
      "Honor `context.signal`, key starts by `context.idempotencyKey`, and keep old",
      "versions in `ServiceModule.previousExternalJobAdapters`; see `context.json`.",
      "```ts",
      'return { kind: "accepted", job: { v: 1 }, pollAfterSeconds: 60 };',
      'return { kind: "safe-to-start", basis: "idempotent-replay" };',
      'return { kind: "retry", issue: { code: "rate_limited", retryAfterSeconds: 30 } };',
      'const adapter = { mode: "external-job", version: "v1" };',
      "const response = await boundedFetch(reviewedEndpoint(base, REVIEWED).toString(), init);",
      "```",
      "Use `boundedFetch`, `pinnedHttpRequest`, or `reviewedEndpoint` for product HTTP",
      "(`src/core/security/pinnedHttp.ts`, `reviewedEndpoint.ts`, `PinnedHttpResponse`).",
    ].join("\n");
    expect(findUnknownAdapterReferences(text, api)).toEqual([]);
  });

  it("flags the retired single routing rule and capability claims lite does not have", () => {
    for (const retired of [
      "Use the minimal starter only when every operation is one-shot and terminal within 50 seconds.",
      "When fit is uncertain, prefer the full starter.",
      "Start there when uncertain; removing unnecessary features is safer.",
      "If that cannot finish synchronously, stop and use `provider-full`.",
      "| Product job continues after HTTP response | Not supported | Supported |",
      "Choose provider-full for long-running work that takes hours.",
      "The minimal starter supports cancellation through its lifecycle route.",
      "Lite does not support product jobs that continue after the response.",
      "The full starter offers paid recovery for failed orders.",
    ]) {
      expect(findRoutingContradictions(retired), retired).not.toEqual([]);
    }
  });

  it("catches retired rules phrased other ways, and lifecycle hooks the API lacks", () => {
    for (const retired of [
      "Jobs that take more than a minute need provider-full.",
      "Jobs that run for hours should use the full starter.",
      "Asynchronous jobs require provider-full.",
      "The lite starter only supports synchronous calls.",
      "Lite can't run jobs that outlive the call.",
      "When in doubt, choose provider-full.",
      "If you are unsure, choose provider-full.",
      "Lite supports cancellation without extra code.",
      "Use the minimal starter when every call finishes within fifty seconds.",
      "Calls must finish in 50s.",
    ]) {
      expect(findRoutingContradictions(retired), retired).not.toEqual([]);
    }
    const code = [
      "1. In the adapter:",
      "   ```ts",
      "   await cancel(context, job);",
      '   return { "kind": "running" };',
      "   ```",
      "",
      "Or `return { kind: 'stalled' }` from `poll`.",
    ].join("\n");
    expect(findUnknownAdapterReferences(code, api).sort()).toEqual([
      '"running" is not a declared outcome kind',
      '"stalled" is not a declared outcome kind',
      "cancel(context, ...) is not a declared adapter hook",
    ]);
  });

  it("does not flag correct statements, paths or other APIs", () => {
    for (const correct of [
      "Lite external-job mode handles long-running product jobs; provider-full is for human review.",
      "Install the runtime bundle before the provider-full registration step.",
      "This repository supports fixed prices; dynamic pricing needs provider-full.",
      "- jobs that run for hours use external-job mode\n- provider-full covers human review",
    ]) {
      expect(findRoutingContradictions(correct), correct).toEqual([]);
    }
    const code = [
      "Tests live in `tests/adapter.test.ts`; CommonJS uses `module.exports`.",
      '`runSupplierOperation({kind: "sample.create"})` and `fetch(url, {mode: "no-cors"})`.',
      "`request.context.contextId` is the caller's.",
    ].join("\n");
    expect(findUnknownAdapterReferences(code, api)).toEqual([]);
  });

  it("accepts the three-path rule as the skill states it", () => {
    const text = [
      "| Lite synchronous (`provider`) | Fixed price; automated terminal result within the 50-second synchronous budget. |",
      "",
      "Duration alone does not select `provider-full`. An x402 endpoint alone does not prove compatibility.",
      "Recovery after a provider-terminal paid failure is a deferred full feature group: never promise it.",
      "It requires `provider-full` for asset ownership and cancellation; the duration is not what decides it.",
      "2. Drain: wait at least 50 seconds (the synchronous budget) plus margin.",
    ].join("\n");
    expect(findRoutingContradictions(text)).toEqual([]);
  });

  it("flags evaluation fixtures an installed skill cannot see, and accepts the scenario wording", () => {
    const retired = [
      "A second fixture: the same audit documented only as a public x402 endpoint.",
      "Report those gaps; do not infer compatibility from the first fixture.",
      "Compare with test/fixtures/skill-evaluations/cases.json (case S-T03).",
    ].join("\n");
    expect(findEvaluationReferences(retired).sort()).toEqual([
      'refers to an evaluation fixture an installed skill does not include: "S-T03"',
      'refers to an evaluation fixture an installed skill does not include: "first fixture"',
      'refers to an evaluation fixture an installed skill does not include: "second fixture"',
      'refers to an evaluation fixture an installed skill does not include: "skill-evaluations"',
    ]);
    expect(findEvaluationReferences([
      "Counter-example: the same audit documented only as a public x402 endpoint.",
      "Do not infer compatibility from the walkthrough above.",
      "Never make readiness or admission permissive to unblock a fixture or deploy.",
      "The tested revision is recorded in `test/fixtures/provider-wire.source.json`.",
    ].join("\n"))).toEqual([]);
  });

  it("counts lines so the 180-line entrypoint cap is exact", () => {
    const text = (count: number, eol = "\n") => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join(eol);
    expect(SKILL_MAX_LINES).toBe(180);
    for (const eol of ["\n", "\r\n", "\r"]) {
      // One final line break ends the last line; it does not start another.
      expect(countLines(text(180, eol) + eol), JSON.stringify(eol)).toBe(180);
      expect(countLines(text(180, eol)), JSON.stringify(eol)).toBe(180);
      expect(countLines(text(181, eol) + eol), JSON.stringify(eol)).toBe(181);
      expect(countLines(text(181, eol)), JSON.stringify(eol)).toBe(181);
      // A blank line before the final break is a line of its own.
      expect(countLines(text(180, eol) + eol + eol), JSON.stringify(eol)).toBe(181);
    }
    expect([countLines(""), countLines("\n"), countLines("one")]).toEqual([0, 1, 1]);
  });
});

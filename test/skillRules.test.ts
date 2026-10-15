import { describe, expect, it } from "vitest";
import {
  findRoutingContradictions,
  findUnknownAdapterReferences,
  readAdapterApi,
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
  });

  it("flags references to members and outcomes the API does not declare", () => {
    const text = [
      "Call `adapter.cancel(context)` and read `context.jobUrl`.",
      "```ts",
      'return { kind: "running" };',
      'return { kind: "safe-to-start", basis: "eventual-search" };',
      'const adapter = { mode: "async" };',
      'return { kind: "retry", issue: { code: "network" } };',
      "module.retryFailedOrder();",
      "```",
    ].join("\n");
    expect(findUnknownAdapterReferences(text, api).sort()).toEqual([
      '"async" is not a declared adapter mode',
      '"eventual-search" is not a declared safe-to-start basis',
      '"network" is not a declared call-issue code',
      '"running" is not a declared outcome kind',
      "adapter.cancel is not a declared member",
      "context.jobUrl is not a declared member",
      "module.retryFailedOrder is not a declared member",
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
      "```",
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
});
